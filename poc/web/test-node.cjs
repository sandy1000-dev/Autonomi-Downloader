// Node harness: proves the ACTUAL wasm32-unknown-unknown artifact decrypts
// real Autonomi fixtures end-to-end, rebuilt in the browser.
//
//   original Autonomi file (fixture)
//     -> encrypted chunks + msgpack DataMap  (what the gateway would serve)
//     -> wasm_crypto (WebAssembly, wasm-bindgen glue)
//     -> plaintext
//     -> SHA-256 verified with Node's built-in crypto (no npm deps).
//
// Run:  node test-node.cjs <fixture_dir> [<fixture_dir> ...]

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const wasm = require('../wasm-crypto/pkg/wasm_crypto.js');

// Minimal decode of the wasm-bindgen Uint8Array return into a Node Buffer.
function toBuffer(ui8) {
  if (ui8 instanceof Uint8Array) return Buffer.from(ui8);
  return Buffer.from(ui8);
}

// Resolve a possibly-shrunk (child) public DataMap to its ROOT DataMap.
// Algorithm mirrors native get_root_data_map():
//   while map.child != null:
//     decrypt each wrapper chunk (at its index, using the CURRENT map's
//     src_hashes and child level) -> yields bincode serialization of the
//     parent DataMap; parse it and continue.
// `fetchChunk(dstHex)` returns a Buffer of encrypted bytes for an address.
function resolveRoot(msgpackDm, fetchChunk) {
  let dm = JSON.parse(wasm.datamap_from_msgpack(new Uint8Array(msgpackDm)));
  let level = 0;
  while (dm.child !== null && dm.child !== undefined) {
    if (level++ > 100) throw new Error('DataMap recursion depth exceeded');
    const srcHashes = JSON.stringify(dm.chunks.map((c) => c.src_hash));
    let parentBincode = [];
    for (let i = 0; i < dm.chunks.length; i++) {
      const c = dm.chunks[i];
      const enc = fetchChunk(c.dst_hash);
      // Integrity: encrypted wrapper chunk must hash to its destination.
      const gotDst = wasm.content_hash(new Uint8Array(enc));
      if (gotDst !== c.dst_hash) throw new Error(`wrapper chunk ${i}: dst_hash mismatch`);
      const plain = toBuffer(wasm.decrypt_chunk_wasm(i, new Uint8Array(enc), srcHashes, dm.child));
      const gotSrc = wasm.content_hash(new Uint8Array(plain));
      if (gotSrc !== c.src_hash) throw new Error(`wrapper chunk ${i}: src_hash mismatch`);
      parentBincode.push(plain);
    }
    dm = JSON.parse(wasm.datamap_from_bincode(new Uint8Array(Buffer.concat(parentBincode))));
  }
  return dm;
}

function runFixture(dir) {
  const base = dir;
  const dm = fs.readFileSync(path.join(base, 'datamap.msgpack'));
  const expectedSha = fs.readFileSync(path.join(base, 'original.sha256'), 'utf8').trim();

  const fetchChunk = (dst) => fs.readFileSync(path.join(base, 'chunks', `${dst}.chunk`));

  // 1. Parse + resolve the public DataMap to its ROOT form.
  const dmJson = JSON.parse(wasm.datamap_from_msgpack(new Uint8Array(dm)));
  const isChild = dmJson.child !== null && dmJson.child !== undefined;
  const root = resolveRoot(dm, fetchChunk);
  const chunks = root.chunks;
  const origSize = root.original_file_size;
  console.log(`  DataMap: ${chunks.length} chunks, original_file_size=${origSize}${isChild ? ' (resolved from shrunk map)' : ''}`);

  // 2. Extract ordered src_hashes once.
  const srcHashesJson = JSON.stringify(chunks.map((c) => c.src_hash));

  // 3. Fetch each encrypted file chunk, hand to WASM for per-chunk decryption.
  let totalOut = 0;
  const hash = crypto.createHash('sha256');
  for (let i = 0; i < chunks.length; i++) {
    const dst = chunks[i].dst_hash;
    const enc = fetchChunk(dst);

    const gotDst = wasm.content_hash(new Uint8Array(enc));
    if (gotDst !== dst) throw new Error(`chunk ${i}: dst_hash mismatch`);

    const plain = toBuffer(wasm.decrypt_chunk_wasm(i, new Uint8Array(enc), srcHashesJson, 0));
    totalOut += plain.length;

    const gotSrc = wasm.content_hash(new Uint8Array(plain));
    if (gotSrc !== chunks[i].src_hash) throw new Error(`chunk ${i}: src_hash mismatch`);
    if (plain.length !== chunks[i].src_size) throw new Error(`chunk ${i}: size mismatch`);

    hash.update(plain);
  }

  const sha = hash.digest('hex');
  if (sha !== expectedSha) throw new Error(`SHA-256 mismatch: ${sha} != ${expectedSha}`);
  if (totalOut !== origSize) throw new Error(`size mismatch: ${totalOut} != ${origSize}`);

  console.log(`  OK: ${path.basename(base)} -> ${totalOut} bytes, SHA-256=${sha}`);
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: node test-node.cjs <fixture_dir> [...]');
  process.exit(2);
}
for (const t of targets) runFixture(t);
console.log('\nAll WASM decryptions verified (SHA-256 match).');
