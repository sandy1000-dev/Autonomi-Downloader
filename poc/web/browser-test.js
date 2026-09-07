// Browser-level test harness: runs the full gateway->WASM->reconstruct flow in
// a real browser and reports the SHA-256 of the reconstructed file (via Web
// Crypto, no npm). Driven by headless Chrome:
//   /browser-test.html?addr=<64hex>&sha256=<expected>
import init, {
  content_hash,
  datamap_from_msgpack,
  datamap_from_bincode,
  decrypt_chunk_wasm,
} from './wasm/wasm_crypto.js';

const out = document.getElementById('out');
function log(m) { out.textContent += m + '\n'; }
function concat(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const o = new Uint8Array(total); let off = 0;
  for (const a of arrays) { o.set(a, off); off += a.length; }
  return o;
}
async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return new Uint8Array(await r.arrayBuffer());
}
async function sha256Hex(u8) {
  const d = await crypto.subtle.digest('SHA-256', u8);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function resolveRoot(msgpackDm) {
  let dm = JSON.parse(datamap_from_msgpack(msgpackDm));
  let depth = 0;
  while (dm.child !== null && dm.child !== undefined) {
    if (depth++ > 100) throw new Error('recursion');
    const src = JSON.stringify(dm.chunks.map((c) => c.src_hash));
    const parts = [];
    for (let i = 0; i < dm.chunks.length; i++) {
      const c = dm.chunks[i];
      const enc = await fetchBytes(`/chunk/${c.dst_hash}`);
      if (content_hash(enc) !== c.dst_hash) throw new Error('wrapper dst mismatch');
      parts.push(decrypt_chunk_wasm(i, enc, src, dm.child));
    }
    dm = JSON.parse(datamap_from_bincode(concat(parts)));
  }
  return dm;
}

(async () => {
  await init();
  const params = new URLSearchParams(location.search);
  const addr = params.get('addr');
  const expected = params.get('sha256');
  log(`addr=${addr} expected=${expected}`);
  try {
    const dm = await fetchBytes(`/datamap/${addr}`);
    const root = await resolveRoot(dm);
    const src = JSON.stringify(root.chunks.map((c) => c.src_hash));
    const parts = [];
    for (let i = 0; i < root.chunks.length; i++) {
      const c = root.chunks[i];
      const enc = await fetchBytes(`/chunk/${c.dst_hash}`);
      if (content_hash(enc) !== c.dst_hash) throw new Error(`chunk ${i} dst mismatch`);
      parts.push(decrypt_chunk_wasm(i, enc, src, 0));
    }
    const full = concat(parts);
    const sha = await sha256Hex(full);
    log(`RESULT sha256=${sha} size=${full.length}`);
    log(sha === expected && full.length === Number(root.original_file_size)
      ? 'RESULT PASS' : 'RESULT FAIL');
  } catch (e) {
    log(`RESULT ERROR ${e.message}`);
  }
})();
