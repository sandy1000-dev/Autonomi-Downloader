# Roadmap

## Phase 1 — Feasibility POC ✅ COMPLETE
- [x] Research current Autonomi architecture (source code tracing).
- [x] Determine public data path: address → DataMap → chunks → decrypt → reconstruct.
- [x] Assess WASM compatibility of `self_encryption`; identify and resolve blockers.
- [x] Build native reference CLI using pristine upstream crate.
- [x] Build vendored `self_encryption` with minimal WASM patches.
- [x] Build `wasm-crypto` wrapper with `wasm-bindgen`.
- [x] Native round-trip tests (1 KB, 1 MB, 10 MB, 100 MB, 1 GB) — SHA-256 verified.
- [x] Node WASM harness tests (same wasm artifact) — SHA-256 verified.
- [x] HTTP integration test against encrypted gateway — SHA-256 verified.
- [x] Browser-target WASM glue smoke test (V8/WebAssembly).
- [x] **Headless browser end-to-end test** (Chrome → gateway → WASM → SHA-256 verify) — PASS.
- [x] **Shrunk/child DataMap resolution** verified (100 MB and 1 GB fixtures) — PASS.
- [x] Privacy proof: gateway serve log shows only encrypted bytes.

## Phase 2 — Technical MVP ✅ COMPLETE
- [x] Deploy a real gateway service (Rust) wrapping `ant-core` — `poc/live-gateway/` works end-to-end.
- [x] Implement the actual gateway using `chunk_get` and `data_map_fetch` from `ant-core` (no server-side decryption).
- [x] Support fetching from the live Autonomi network (not just local fixtures) — verified with real 2.6 MB PNG.
- [x] Implement peer-cache bootstrap matching `ant-cli` logic (load cached peers, start P2P node, promote discovered peers).
- [x] ~~Implement child/shrunk DataMap resolution in the browser~~ ✅ Done in POC (verified up to 1 GB).
- [x] Add CORS and static file serving for the gateway.
- [ ] Add rate limiting and TLS certificates for production deployment.
- [x] Verify large-file streaming in real browsers (Chrome, Edge) — File System Access API streams directly to disk.
- [x] Add progress indicator in browser UI (per-chunk status line).
- [ ] Add cancel/resume support and error handling for network timeouts.
- [ ] Benchmark download throughput end-to-end.

## Phase 3 — Polished Web Downloader
- [ ] Clean responsive UI (address input, drag-and-drop, history of recent addresses).
- [x] Support the File System Access API (`showSaveFilePicker` + `createWritable`) with Blob fallback.
- [ ] Service Worker for offline caching of the WASM module and chunk retry logic.
- [ ] Filename suggestion from URL fragment or user input (public DataMaps do not store original filename).
- [ ] Integrity dashboard: show per-chunk dst_hash/src_hash verification status to the user.

## Phase 4 — Optimisation
- [ ] Parallel chunk fetching (fetch N chunks concurrently via `Promise.all`).
- [ ] Web Worker for decryption (offload WASM from the main thread).
- [ ] Streaming decompression (evaluate Brotli stream support in browser WASM).
- [ ] Gateway-side caching / CDN for popular chunks (they're immutable, content-addressed).
- [ ] Firefox/Safari large-file support via Origin Private File System or StreamSaver-style service worker.

## Phase 5 — Optional Advanced Features (Out of MVP Scope)
- [ ] Private data download (requires wallet, payment, private key handling — fundamentally different flow).
- [ ] Upload capability (requires wallet, payment, chunk PUT).
- [ ] Tor / proxy gateway support for metadata privacy.
- [ ] Desktop application (Tauri/Electron) with built-in node for direct P2P (removes gateway entirely).
