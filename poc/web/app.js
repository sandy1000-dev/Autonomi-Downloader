// Browser-side core for the Autonomi Downloader POC.
//
// Flow:
//   public address
//     -> GET /datamap/{address}      (msgpack DataMap — encrypted-agnostic metadata)
//     -> resolve shrunk/child maps   (fetch + decrypt wrapper chunks)
//     -> root DataMap (chunk list)
//     -> for each chunk:
//          GET /chunk/{dst_hash}     (encrypted bytes)
//          verify blake3(encrypted) == dst_hash
//          decrypt in WASM
//          verify blake3(plaintext) == src_hash
//          stream plaintext to disk
// The gateway only ever served encrypted bytes; all decryption is local.

import init, {
  content_hash,
  datamap_from_msgpack,
  datamap_from_bincode,
  decrypt_chunk_wasm,
  extract_src_hashes,
} from './wasm/wasm_crypto.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const btn = $('go');
let wasmReady = false;

function setStatus(msg, cls = '') {
  statusEl.innerHTML = `<span class="${cls}">${msg}</span>`;
}
function esc(s) { return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`gateway returned ${r.status} for ${url}`);
  }
  return new Uint8Array(await r.arrayBuffer());
}

// Resolve a possibly-shrunk (child) DataMap to its ROOT form, exactly like the
// native get_root_data_map(). Wrapper chunks decrypt to a bincode DataMap.
async function resolveRoot(msgpackDm) {
  let dm = JSON.parse(datamap_from_msgpack(msgpackDm));
  let depth = 0;
  while (dm.child !== null && dm.child !== undefined) {
    if (depth++ > 100) throw new Error('DataMap recursion too deep');
    const srcHashes = JSON.stringify(dm.chunks.map((c) => c.src_hash));
    const fragments = [];
    for (let i = 0; i < dm.chunks.length; i++) {
      const c = dm.chunks[i];
      const enc = await fetchBytes(`/chunk/${c.dst_hash}`);
      if (content_hash(enc) !== c.dst_hash) throw new Error(`wrapper chunk ${i} failed dst_hash check`);
      const plain = decrypt_chunk_wasm(i, enc, srcHashes, dm.child);
      if (content_hash(plain) !== c.src_hash) throw new Error(`wrapper chunk ${i} failed src_hash check`);
      fragments.push(plain);
    }
    dm = JSON.parse(datamap_from_bincode(concat(fragments)));
  }
  return dm;
}

function concat(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// Pick the best save mechanism.
async function openFileSink(filename, size) {
  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({
      suggestedName: filename || 'download.bin',
    });
    const writable = await handle.createWritable();
    return { write: (bytes) => writable.write(bytes), close: () => writable.close() };
  }
  // Fallback (Firefox / Safari / older browsers): accumulate into chunks and
  // produce a Blob at the end. Bounded by available RAM — fine for small files.
  const parts = [];
  return {
    write: (bytes) => { parts.push(bytes); return Promise.resolve(); },
    close: () => {
      const blob = new Blob(parts, { type: 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename || 'download.bin';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      return Promise.resolve();
    },
  };
}

async function downloadAddress(address, suggestedName, precreatedSink) {
  setStatus(`Fetching DataMap at ${address.slice(0, 16)}…`);
  const dm = await fetchBytes(`/datamap/${address}`);

  setStatus('Resolving DataMap…');
  const root = await resolveRoot(dm);
  const chunks = root.chunks;
  const srcHashesJson = JSON.stringify(chunks.map((c) => c.src_hash));
  const origSize = root.original_file_size;

  setStatus(`Resolved ${chunks.length} chunks (${origSize} bytes). Downloading…`);

  // Use the pre-created sink (File System Access API) or fall back to Blob accumulation.
  const sink = precreatedSink || await openFileSink(suggestedName, origSize);

  let done = 0;
  let totalPlain = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const enc = await fetchBytes(`/chunk/${c.dst_hash}`);
    if (content_hash(enc) !== c.dst_hash) throw new Error(`chunk ${i} dst_hash mismatch`);
    const plain = decrypt_chunk_wasm(i, enc, srcHashesJson, 0);
    if (content_hash(plain) !== c.src_hash) throw new Error(`chunk ${i} src_hash mismatch`);
    if (plain.length !== c.src_size) throw new Error(`chunk ${i} size mismatch`);
    await sink.write(plain); // stream to disk / accumulate
    totalPlain += plain.length;
    done++;
    setStatus(`Decrypting… ${done}/${chunks.length} chunks (${Math.round(totalPlain / 1048576)} MiB)`);
    // Yield to let the UI / stream flush on large files.
    await new Promise((r) => setTimeout(r, 0));
  }

  await sink.close();
  if (totalPlain !== origSize) throw new Error(`size mismatch: ${totalPlain} != ${origSize}`);
  setStatus(`✔ Downloaded ${totalPlain} bytes. All integrity checks passed.`, 'ok');
}

async function main() {
  await init();
  wasmReady = true;
  setStatus('WASM crypto module ready. Paste a public address and press Download.');

  $('addr').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  btn.addEventListener('click', run);
}

async function run() {
  if (!wasmReady) return;
  const addr = $('addr').value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(addr)) {
    setStatus('Please enter a valid 64-character hex Autonomi address.', 'err');
    return;
  }

  // For Chrome/Edge, acquire the file handle NOW while we're still inside the
  // user gesture. Any await before showSaveFilePicker() expires the gesture.
  let precreatedSink = null;
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: 'autonomi-download.bin' });
      const writable = await handle.createWritable();
      precreatedSink = {
        write: (bytes) => writable.write(bytes),
        close: () => writable.close(),
      };
    } catch (e) {
      if (e.name === 'AbortError') {
        setStatus('Save cancelled.', 'err');
        return;
      }
      throw e;
    }
  }

  btn.disabled = true;
  try {
    await downloadAddress(addr, 'autonomi-download.bin', precreatedSink);
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${esc(e.message)}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

main();
