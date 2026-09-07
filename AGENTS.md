# Agent Context — Autonomi Browser Downloader

> This file exists for AI agents (and the human author) working on this codebase.
> It is NOT for public visitors — see [`README.md`](README.md) for that.

---

## 1. Project Identity

**Mission:** Prove that a web browser can download and decrypt public Autonomi data with **zero server-side decryption**. The gateway is a "dumb encrypted transport" — it only serves encrypted chunks and DataMaps. All decryption happens client-side in WASM.

**Status:** Experimental POC. Phase 1 (feasibility) and Phase 2 (live-network MVP) are complete per [`ROADMAP.md`](ROADMAP.md).

---

## 2. Repo Topology

```
/
├── poc/                          ← ORIGINAL WORK (this project)
│   ├── live-gateway/             Rust Axum gateway → live Autonomi network
│   ├── wasm-crypto/              WASM decrypt module (wasm-bindgen wrapper)
│   ├── web/                      Browser UI (HTML/JS) + local test gateway
│   ├── cli/                      Native fixture generator
│   ├── fixtures/                 Generated test files (1 KB – 1 GB)
│   └── vendor/self_encryption/   Patched copy used by wasm-crypto
│
├── ant-client/                   ← VENDORED FORK of WithAutonomi/ant-client
├── ant-sdk/                      ← VENDORED FORK of WithAutonomi/ant-sdk
└── self_encryption/              ← VENDORED FORK of WithAutonomi/self_encryption
```

### What is vendored vs original

- **`poc/`** contains all the original code written for this proof-of-concept.
- **`ant-client/`, `ant-sdk/`, `self_encryption/`** are upstream forks included in-repo so the gateway and WASM module can depend on them with local path references. They have **minimal patches** (see §7).
- The upstream forks are **NOT** submodules — they are copied trees. If you edit them, note the divergence.

---

## 3. Build Map

Build order matters because `live-gateway` and `wasm-crypto` depend on the vendored crates.

### Prerequisites
- Rust (latest stable)
- `wasm-bindgen-cli` (`cargo install wasm-bindgen-cli`)
- Node.js (for local gateway and tests)

### Step A — Build vendored crates (implicit via Cargo)
```bash
cd poc/wasm-crypto
cargo build --target wasm32-unknown-unknown --release
wasm-bindgen --target web --out-dir ../web/wasm \
  target/wasm32-unknown-unknown/release/wasm_crypto.wasm
```

### Step B — Build live gateway
```bash
cd poc/live-gateway
cargo build --release
# run:
cargo run --release
```

### Step C — Generate test fixtures (optional, for local testing)
```bash
cd poc/cli
cargo build --release
mkdir -p ../fixtures
./target/release/gen 1024      ../fixtures/1kb
./target/release/gen 1048576   ../fixtures/1mb
./target/release/gen 10485760  ../fixtures/10mb
./target/release/gen 104857600 ../fixtures/100mb
./target/release/gen 1073741824 ../fixtures/1gb
```

### Step D — Run local encrypted gateway (optional, for local testing)
```bash
cd poc/web
node gateway.cjs ../fixtures/1mb ../fixtures/100mb --port 8099
```

---

## 4. Key Technical Constraints & Invariants

### Hard Invariants (never break these)
1. **Gateway never decrypts.** It only proxies `data_map_fetch()` and `chunk_get()` from `ant-core`.
2. **Gateway never stores plaintext.** Static files (HTML/JS/WASM) are the only non-encrypted bytes it serves.
3. **Per-chunk streaming.** The browser must never hold the entire file in RAM. Decrypt one chunk, stream to disk, repeat.

### WASM Patches (4 changes to `self_encryption`)
To compile `self_encryption` to `wasm32-unknown-unknown`:
1. Gate `rayon` parallel iteration in `decrypt.rs` behind `#[cfg(not(target_arch = "wasm32"))]`.
2. Gate `test_helpers` module behind the same cfg (removes `OsRng` / `getrandom` compile issue).
3. Remove `tokio` from `[dependencies]` in `Cargo.toml` (only used in doc examples).
4. Add `getrandom = { version = "0.2", features = ["js"] }` to enable `rand` entropy on wasm.

### Peer-Cache Bootstrap (critical for live network)
The gateway **cannot** reach live peers with an empty bootstrap list. It must replicate `ant-cli`'s peer-cache logic:
1. Load `client_peer_cache.json` from disk (`peer_cache::cache_path()`).
2. Create `CoreNodeConfig` with `mode(NodeMode::Client)` and bootstrap peers from cache.
3. Start `P2PNode`, then call `peer_cache::promote_connected_direct_peers()`.
4. Wrap in `Client::from_node_with_peer_cache()`.

Without this, every address returns 404 because the gateway cannot find peers storing the data.

### Browser Constraints
- **File System Access API requires user gesture:** `showSaveFilePicker()` must be called **directly inside the click handler**, before any `await`. The file picker is acquired immediately on click, then passed into the download routine.
- **Public DataMaps do not store the original filename.** The save dialog defaults to `autonomi-download.bin`; the user must type the desired name and extension.
- **axum 0.8 route syntax:** Uses `{param}` not `:param`. The latter panics at runtime.

---

## 5. File Guide

| File | Responsibility |
|------|---------------|
| [`poc/live-gateway/src/main.rs`](poc/live-gateway/src/main.rs) | Axum server, peer-cache bootstrap, `/datamap/{addr}`, `/chunk/{addr}`, `/health` |
| [`poc/wasm-crypto/src/lib.rs`](poc/wasm-crypto/src/lib.rs) | WASM exports: `datamap_from_msgpack`, `extract_src_hashes`, `decrypt_chunk_wasm`, `content_hash` |
| [`poc/web/app.js`](poc/web/app.js) | Browser orchestrator: fetch DataMap → resolve child maps → fetch chunks → WASM decrypt → stream to disk |
| [`poc/web/index.html`](poc/web/index.html) | Static UI |
| [`poc/web/gateway.cjs`](poc/web/gateway.cjs) | **Local test gateway** (Node.js). Serves encrypted fixtures. Not the live gateway. |
| [`poc/cli/src/gen.rs`](poc/cli/src/gen.rs) | Fixture generator: creates deterministic test files + encrypts them + writes DataMaps |
| [`poc/wasm-crypto/tests/native_roundtrip.rs`](poc/wasm-crypto/tests/native_roundtrip.rs) | Native Rust test: encrypt fixture → decrypt via `decrypt_all` → verify SHA-256 |
| [`poc/web/test-node.cjs`](poc/web/test-node.cjs) | Node WASM harness: loads WASM, decrypts fixtures, verifies SHA-256 |
| [`poc/web/test-http.cjs`](poc/web/test-http.cjs) | HTTP integration test: fetches from gateway, decrypts via WASM, verifies SHA-256 |
| [`poc/web/run-browser-test.sh`](poc/web/run-browser-test.sh) | Headless Chrome E2E test |
| [`RESEARCH.md`](RESEARCH.md) | Encryption details, data flow, upstream architecture survey |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | System architecture, deployment architecture, file-size handling |
| [`SECURITY.md`](SECURITY.md) | Threat model, integrity checks, metadata exposure |

---

## 6. Test Matrix

Run these in order when making changes:

1. **Native round-trip** — `cd poc/wasm-crypto && cargo test`
   - Proves the vendored `self_encryption` decrypt logic matches upstream behavior.
2. **Node WASM harness** — `cd poc/web && node test-node.cjs <fixtures...>`
   - Proves the actual `wasm_crypto.wasm` artifact decrypts correctly.
3. **HTTP integration** — `node test-http.cjs http://localhost:8099 <addr> <sha> <size>`
   - Proves gateway + fetch + WASM decrypt chain works end-to-end.
4. **Headless browser E2E** — `cd poc/web && ./run-browser-test.sh`
   - Proves Chrome can load WASM, fetch from gateway, decrypt, and verify SHA-256.

All four must pass before declaring a change safe.

---

## 7. Upstream Divergence Summary

| Crate | Patch | Why |
|-------|-------|-----|
| `self_encryption` | Gate `rayon` in `decrypt.rs` | `rayon` does not compile for `wasm32-unknown-unknown` |
| `self_encryption` | Gate `test_helpers` module | Removes `getrandom`/`OsRng` dependency that breaks wasm |
| `self_encryption` | Remove `tokio` from hard deps | `tokio` is only used in doc examples; breaks wasm build |
| `self_encryption` | Add `getrandom = { features = ["js"] }` | Enables `rand` crate to source entropy in browser WASM |
| `ant-client` | Local path references | Gateway depends on `ant-core` from this vendored tree |

**Do not** make broad refactoring changes to the vendored crates unless absolutely necessary. If you do, document the divergence here and in the crate's own README/CHANGELOG.


---

## 8. Common Pitfalls / Gotchas

- **Empty bootstrap peers = 404s.** If the gateway returns 404 for everything, it failed to bootstrap into the P2P network. Check `client_peer_cache.json` and UDP firewall rules.
- **axum route syntax.** `{address}` is correct. `:address` will panic at runtime in axum 0.8.
- **User gesture expiry.** In `app.js`, `showSaveFilePicker()` must be called synchronously inside the click handler. Any `await` before it invalidates the gesture.
- **Filename missing.** Public DataMaps do not contain the original filename. The UI must tell the user to type it in the save dialog.
- **WASM build target.** Always use `wasm32-unknown-unknown`, not `wasm32-wasi`.
- **wasm-bindgen output.** The `wasm-bindgen` CLI must match the version in `Cargo.lock`. If you get ABI mismatches, reinstall `wasm-bindgen-cli` to the matching version.
- **Child DataMap recursion.** Large files (> ~12 MB) have `child = Some(n)` in their DataMap. The browser must recursively fetch wrapper chunks, decrypt them, and parse the parent DataMap until `child == null`. See `resolveRoot()` in `app.js`.
- **Integrity checks at every step:**
  - Pre-decrypt: `content_hash(encrypted) == dst_hash`
  - Post-decrypt: `content_hash(plaintext) == src_hash`
  - Post-reconstruct: `sum(src_size) == original_file_size`

---

## 9. Technology Stack

| Layer | Tech |
|-------|------|
| Gateway | Rust, axum 0.8, tokio, `ant-core` |
| P2P Network | Autonomi (QUIC, DHT, self-encryption) |
| WASM Crypto | Rust, `wasm-bindgen`, `self_encryption`, `chacha20poly1305`, `brotli` |
| Browser UI | Vanilla JS (ES modules), HTML5 File System Access API |
| Local Test GW | Node.js, Express-like static server |
| Tests | Rust `cargo test`, Node.js, headless Chrome |

---

## 10. If You're Starting Fresh

1. Read [`ARCHITECTURE.md`](ARCHITECTURE.md) for the system picture.
2. Read [`RESEARCH.md`](RESEARCH.md) for the encryption and networking deep-dive.
3. Build in this order: fixtures → wasm-crypto → live-gateway.
4. Run tests in this order: native → node → http → browser.
5. When in doubt, grep for `tracing::info!` / `tracing::error!` in the gateway and `console.error` in `app.js`.

