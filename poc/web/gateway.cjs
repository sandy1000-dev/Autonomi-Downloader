#!/usr/bin/env node
// Minimal ENCRYPTED gateway for the browser POC.
//
// Acts like the Autonomi network surface that `antd`'s chunk_get exposes:
// it stores/retrieves plain CONTENT-ADDRESSED BYTES (encrypted chunks and the
// msgpack DataMap) and NEVER decrypts anything. It is deliberately a dumb
// encrypted transport — the only thing it can do with the public address is
// return the matching encrypted bytes.
//
// Usage:   node gateway.cjs <fixture_dir> [<fixture_dir> ...] [--port N]
// Serves:
//   GET /datamap/:address   -> msgpack DataMap bytes (if address matches)
//   GET /chunk/:address     -> encrypted chunk bytes (if address matches)
//   GET /                    -> web app (index.html)
//   GET /app.js, /wasm/*     -> browser code + wasm module
//
// No npm deps. Uses the node wasm binding solely to compute content hashes
// for address registration (this is addressing, not decryption).

const http = require('http');
const fs = require('fs');
const path = require('path');
const wasm = require('../wasm-crypto/pkg/wasm_crypto.js');

const ROOT = __dirname + '/..'; // poc/
const WEB = path.join(ROOT, 'web');

// ---- Address registration -------------------------------------------------
// datamaps[addressHex] = { msgpack, fixtureDir }
// chunks  [addressHex] = { bytes, fixtureDir }   (loaded lazily from disk)
const datamaps = {};
const chunkIndex = new Map(); // addressHex -> fixtureDir

const args = process.argv.slice(2);
let port = 8099;
const fixtureDirs = [];
for (const a of args) {
  if (a === '--port') continue;
  if (/^\d+$/.test(a)) { port = parseInt(a, 10); continue; }
  fixtureDirs.push(a);
}

function registerFixture(dir) {
  const base = path.resolve(dir);
  const dm = fs.readFileSync(path.join(base, 'datamap.msgpack'));
  const dmAddr = wasm.content_hash(new Uint8Array(dm));
  datamaps[dmAddr] = { msgpack: dm, fixtureDir: base };
  // Register chunk addresses (content hash of each encrypted chunk).
  for (const f of fs.readdirSync(path.join(base, 'chunks'))) {
    if (!f.endsWith('.chunk')) continue;
    const addr = f.slice(0, -'.chunk'.length); // filename == address hex
    const p = path.join(base, 'chunks', f);
    chunkIndex.set(addr, p);
  }
  return dmAddr;
}

for (const d of fixtureDirs) {
  const addr = registerFixture(d);
  console.log(`[gateway] registered ${d}\n          public address = ${addr}`);
}

// ---- Instrumentation (privacy proof) -------------------------------------
let servedBytes = 0;
let servedObjects = 0;
function logServe(kind, addr, n) {
  servedBytes += n;
  servedObjects += 1;
  console.log(`[gateway] serve ${kind} ${addr} (${n} bytes)  [total served: ${servedBytes} bytes]`);
}

// ---- Static files ---------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
};
const staticMap = {
  '/': path.join(WEB, 'index.html'),
  '/index.html': path.join(WEB, 'index.html'),
  '/app.js': path.join(WEB, 'app.js'),
  '/browser-test.html': path.join(WEB, 'browser-test.html'),
  '/browser-test.js': path.join(WEB, 'browser-test.js'),
  '/wasm/wasm_crypto.js': path.join(WEB, 'wasm/wasm_crypto.js'),
  '/wasm/wasm_crypto_bg.wasm': path.join(WEB, 'wasm/wasm_crypto_bg.wasm'),
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  // /datamap/:address
  let m = url.match(/^\/datamap\/([0-9a-f]{64})$/);
  if (m) {
    const addr = m[1];
    if (!datamaps[addr]) {
      console.log(`[gateway] MISS datamap ${addr} -> 404`);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Datamap address not found' }));
      return;
    }
    const body = datamaps[addr].msgpack;
    logServe('datamap', addr, body.length);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(body);
    return;
  }

  // /chunk/:address
  m = url.match(/^\/chunk\/([0-9a-f]{64})$/);
  if (m) {
    const addr = m[1];
    const cp = chunkIndex.get(addr);
    if (!cp) {
      console.log(`[gateway] MISS chunk ${addr} -> 404`);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Chunk address not found' }));
      return;
    }
    const body = fs.readFileSync(cp);
    // Integrity: the address is the content hash — re-verify before serving.
    const h = wasm.content_hash(new Uint8Array(body));
    if (h !== addr) {
      console.log(`[gateway] INTEGRITY VIOLATION chunk ${addr} -> 500`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'chunk content mismatch' }));
      return;
    }
    logServe('chunk', addr, body.length);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(body);
    return;
  }

  // static
  const sp = staticMap[url];
  if (sp && fs.existsSync(sp)) {
    const ext = path.extname(sp);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(fs.readFileSync(sp));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(port, () => {
  console.log(`\n[gateway] listening on http://localhost:${port}`);
  console.log(`[gateway] Open the page, paste a public address above, and hit Download.`);
  console.log(`[gateway] NOTE: this process ONLY serves encrypted bytes (chunks + DataMap).`);
  console.log(`[gateway]       It never sees plaintext. See the serve log for proof.\n`);
});
