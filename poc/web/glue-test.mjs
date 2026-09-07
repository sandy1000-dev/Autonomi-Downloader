// Verify the browser-target (web) wasm-bindgen glue + wasm initialize and run
// correctly in a V8/WebAssembly environment (Node ESM == browser engine).
import initDefault, { initSync, content_hash, datamap_from_msgpack, decrypt_chunk_wasm, extract_src_hashes } from './wasm/wasm_crypto.js';
import { readFileSync } from 'fs';

const bytes = readFileSync(new URL('./wasm/wasm_crypto_bg.wasm', import.meta.url));
const module = new WebAssembly.Module(bytes);
initSync({ module });

// smoke test: content hash of a known buffer
const dm = readFileSync(new URL('../fixtures/1kb/datamap.msgpack', import.meta.url));
const dmJson = JSON.parse(datamap_from_msgpack(new Uint8Array(dm)));
const src = extract_src_hashes(new Uint8Array(dm));
const enc0 = readFileSync(new URL('../fixtures/1kb/chunks/' + dmJson.chunks[0].dst_hash + '.chunk', import.meta.url));
const plain = decrypt_chunk_wasm(0, new Uint8Array(enc0), src, 0);
console.log('WEB-GLUE OK: chunks=' + dmJson.chunks.length);
console.log('  content_hash(encrypted[0]) == dst_hash: ' + (content_hash(new Uint8Array(enc0)) === dmJson.chunks[0].dst_hash));
console.log('  decrypted chunk[0] bytes: ' + plain.length);
console.log('  content_hash(decrypted[0]) == src_hash: ' + (content_hash(new Uint8Array(plain)) === dmJson.chunks[0].src_hash));
