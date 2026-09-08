// HTTP integration test: drives the exact browser->gateway->WASM flow over
// live HTTP, proving the gateway serves only encrypted bytes and that all
// decryption happens client-side. Verifies final SHA-256.
//
//   node test-http.cjs <gatewayUrl> <address> <expected_sha> <expected_size>
//
// The expected_sha/size come from the (private, test-only) fixture — the
// gateway itself never has them.

const crypto = require('crypto');
const wasm = require('../wasm-crypto/pkg/wasm_crypto.js');

function toBuffer(u) { return u instanceof Uint8Array ? Buffer.from(u) : Buffer.from(u); }

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function resolveRoot(baseUrl, msgpackDm) {
  let dm = JSON.parse(wasm.datamap_from_msgpack(new Uint8Array(msgpackDm)));
  let depth = 0;
  while (dm.child !== null && dm.child !== undefined) {
    if (depth++ > 100) throw new Error('map recursion too deep');
    const src = JSON.stringify(dm.chunks.map((c) => c.src_hash));
    const parts = [];
    for (let i = 0; i < dm.chunks.length; i++) {
      const c = dm.chunks[i];
      const enc = await fetchBytes(`${baseUrl}/chunk/${c.dst_hash}`);
      if (wasm.content_hash(new Uint8Array(enc)) !== c.dst_hash) throw new Error(`wrapper ${i} dst mismatch`);
      const plain = toBuffer(wasm.decrypt_chunk_wasm(i, new Uint8Array(enc), src, dm.child));
      if (wasm.content_hash(new Uint8Array(plain)) !== c.src_hash) throw new Error(`wrapper ${i} src mismatch`);
      parts.push(plain);
    }
    dm = JSON.parse(wasm.datamap_from_bincode(new Uint8Array(Buffer.concat(parts))));
  }
  return dm;
}

async function main() {
  const [, , baseUrl, address, expectedSha, expectedSize] = process.argv;
  if (!baseUrl || !address) { console.error('usage: node test-http.cjs <url> <address> <sha> <size>'); process.exit(2); }

  console.log(`GET ${baseUrl}/datamap/${address}`);
  const dm = await fetchBytes(`${baseUrl}/datamap/${address}`);
  if (wasm.content_hash(new Uint8Array(dm)) !== address) throw new Error('DataMap address mismatch');
  const root = await resolveRoot(baseUrl, dm);
  const chunks = root.chunks;
  console.log(`  root DataMap: ${chunks.length} chunks, ${root.original_file_size} bytes`);

  const src = JSON.stringify(chunks.map((c) => c.src_hash));
  const hash = crypto.createHash('sha256');
  let total = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const enc = await fetchBytes(`${baseUrl}/chunk/${c.dst_hash}`);
    if (wasm.content_hash(new Uint8Array(enc)) !== c.dst_hash) throw new Error(`chunk ${i} dst mismatch`);
    const plain = toBuffer(wasm.decrypt_chunk_wasm(i, new Uint8Array(enc), src, 0));
    if (wasm.content_hash(new Uint8Array(plain)) !== c.src_hash) throw new Error(`chunk ${i} src mismatch`);
    total += plain.length;
    hash.update(plain);
  }
  const sha = hash.digest('hex');
  if (total !== Number(expectedSize)) throw new Error(`size mismatch ${total} != ${expectedSize}`);
  if (sha !== expectedSha) throw new Error(`SHA mismatch ${sha} != ${expectedSha}`);
  console.log(`  OK: ${total} bytes, SHA-256=${sha} (matches original)`);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
