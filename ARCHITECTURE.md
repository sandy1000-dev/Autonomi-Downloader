# Architecture — Privacy-Preserving Browser-Based Autonomi Downloader

## Verdict: Encrypted Gateway + Browser-Side WASM Decrypt

```
┌─────────────────────────────────────────────────────────────┐
│                         BROWSER                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────┐ │
│  │   UI/JS     │───→│  WASM module │───→│ File System API │ │
│  │ (orchestrate│    │ (self_encrypt)│    │  / StreamSaver   │ │
│  └─────────────┘    └─────────────┘    └─────────────────┘ │
│         ↑                      ↑                             │
│         │ HTTPS                │ JS calls                   │
│         │                      │                            │
│    Encrypted chunks         Decrypted bytes                 │
│         │                      │                            │
└─────────┼──────────────────────┼────────────────────────────┘
          │                      │
          │ HTTPS                │
          ▼                      │
┌─────────────────┐              │
│  Gateway Server │              │
│  (thin proxy)   │              │
│  /datamap/{addr} │              │
│  /chunk/{addr}   │              │
└────────┬────────┘              │
         │                       │
         │ antd / ant-core       │
         ▼                       │
┌─────────────────┐              │
│  Autonomi Network│              │
│  (P2P/QUIC)     │              │
└─────────────────┘              │
                                 │
                        (privacy boundary: encrypted only)
```

## Browser-Side Components

### JavaScript Orchestrator (`app.js`)
- Accepts a public Autonomi address (64 hex chars).
- Fetches the msgpack DataMap from the gateway.
- Resolves shrunk/child DataMaps to the root DataMap (fetching + decrypting wrapper chunks in WASM).
- Iterates root chunks:
  - `GET /chunk/{dst_hash}`
  - Verifies `content_hash(encrypted) == dst_hash`
  - Calls `wasm.decrypt_chunk_wasm(index, encrypted, src_hashes, child_level)`
  - Verifies `content_hash(decrypted) == src_hash`
  - Streams decrypted bytes to disk (File System Access API on Chrome/Edge; Blob fallback on Firefox/Safari).
- No file ever held fully in RAM (per-chunk streaming).

### WASM Module (`wasm-crypto`)
Built from a **vendored, minimally patched** copy of `self_encryption` 0.36.0:
- Patches required:
  1. Gate `rayon` usage in `decrypt.rs` behind `#[cfg(not(target_arch = "wasm32"))]`.
  2. Gate `test_helpers` module behind same cfg (removes `OsRng` / `getrandom` compile issue).
  3. Remove `tokio` from `[dependencies]` (only used in doc examples).
  4. Add `getrandom = { version = "0.2", features = ["js"] }` (enables `rand` to compile for wasm).
- Exports:
  - `datamap_from_msgpack(msgpack_bytes) -> JSON` — parse public DataMap.
  - `extract_src_hashes(msgpack_bytes) -> JSON array` — one-time key material extraction.
  - `decrypt_chunk_wasm(index, encrypted, src_hashes_json, child_level) -> Uint8Array` — per-chunk decrypt.
  - `datamap_from_bincode(bytes) -> JSON` — for resolving shrunk maps.
  - `content_hash(bytes) -> hex` — BLAKE3 integrity check.

## Gateway

The gateway is a **dumb encrypted transport**. It does the minimum needed to bridge the browser to the Autonomi network:

- `GET /datamap/{address}` → proxies `data_map_fetch(address)`, returns raw msgpack bytes.
- `GET /chunk/{address}` → proxies `chunk_get(address)`, returns raw encrypted chunk bytes.
- `GET /health` → returns peer count and ready status.
- Serves static files (HTML, JS, WASM).
- **Never decrypts, never stores plaintext, never logs plaintext.**

In production this could be a thin Rust/Node service wrapping `ant-core` or `antd`, or even a CDN edge that caches content-addressed encrypted chunks.

## Live-Network Gateway

A working Rust/Axum implementation in `poc/live-gateway/` connects to the live Autonomi network using `ant-core` directly:

```rust
let (client, node) = build_client().await?;
// GET /datamap/{address}  -> client.data_map_fetch(&addr).await -> rmp_serde::to_vec
// GET /chunk/{address}    -> client.chunk_get(&addr).await -> chunk.content
// GET /health             -> node.connected_peers().await.len()
```

### Peer-Cache Bootstrap (Critical)

The gateway **must** replicate `ant-cli`'s bootstrap logic. Simply calling `Client::connect(&[], config)` with empty bootstrap peers produces a P2P node with a thin routing table that cannot reach live peers. The working implementation:

1. **Load cached bootstrap peers** from disk (`peer_cache::cache_path()` → `~/.local/share/autonomi/client_peer_cache.json`).
2. **Create P2P node** with those peers as bootstrap candidates (`CoreNodeConfig::builder()`).
3. **Start the node** (`node.start().await`).
4. **Promote newly discovered peers** back to the cache (`promote_connected_direct_peers`).
5. **Wrap in `Client`** via `Client::from_node_with_peer_cache(...)`.

Without steps 1–4, the gateway returns 404 for every address because it cannot find the peers storing the data.

### Endpoints

| Route | Description |
|-------|-------------|
| `GET /health` | JSON `{ "status": "ready", "connected_peers": N }` |
| `GET /datamap/{address}` | Raw msgpack DataMap bytes from the live network |
| `GET /chunk/{address}` | Raw encrypted chunk bytes (gateway never decrypts) |
| `GET /` | Static files (`index.html`, `app.js`, WASM) |

### Key Observations

- `ant-cli` (and by extension `ant-core`) **auto-discovers bootstrap peers** — it found 6 live peers with zero configuration.
- The official `antd` daemon exposes `GET /v1/chunks/{address}` which returns base64-encoded encrypted chunks (no decryption, no wallet required).
- Our gateway returns **raw binary** rather than base64 JSON.
- **Public DataMaps do not store the original filename**. The browser's save dialog defaults to `autonomi-download.bin`; the user must type the desired name and extension.
- axum 0.8 route syntax uses `{param}`; `:param` panics at runtime.
- `showSaveFilePicker()` must be called directly inside the click handler (before any `await`), or the browser throws "Must be handling a user gesture".


## Production Deployment

The live gateway has been successfully deployed on an Ubuntu 24.04 VPS with the following configuration:

- **Systemd service** for automatic startup and restart on failure
- **Cloudflare Tunnel** for free HTTPS without opening firewall ports
- **Peer cache** copied from development machine to bootstrap DHT connections
- **2GB swap** added for Rust compilation on 2GB RAM VPS

### Deployment Architecture

```
Internet Users
      |
      | HTTPS (Cloudflare Tunnel)
      v
localhost:8099 (gateway on VPS)
      |
      | ant-core P2P
      v
Autonomi Network (live peers)
```

The VPS deployment proved that:
1. The peer-cache bootstrap works on a fresh server (50 cached peers → 6 connected → 75 DHT peers)
2. The gateway remains stable under real user load
3. Cloudflare Tunnel provides adequate performance for testing

## Why Not Fully Browser-Side?

Direct browser → Autonomi network is blocked by:
- Browsers cannot run a QUIC/P2P DHT client (no raw UDP, no native OS sockets).
- No WebRTC/WebTransport bridge exists in the current Autonomi stack.
- The `ant-webex` extension explicitly documents this limitation.

The encrypted gateway preserves the privacy invariant (server never sees plaintext) while making the system buildable today.

## Data Flow Summary

```
public address
    ↓  GET /datamap/{address}
msgpack DataMap (encrypted-agnostic metadata)
    ↓  resolve child maps (if any)
root DataMap → list of (index, src_hash, dst_hash, src_size)
    ↓  for each chunk:
GET /chunk/{dst_hash}  → encrypted bytes
    ↓  WASM decrypt_chunk
XOR unpad → ChaCha20-Poly1305 decrypt → Brotli decompress → plaintext bytes
    ↓  stream to disk
original file
```

## File-Size Handling

| Size | Strategy | RAM footprint |
|------|----------|---------------|
| < 100 MB | Per-chunk decrypt, File System Access API stream | ~one chunk (~4 MB) |
| 100 MB – 1 GB | Same; child-map resolution adds 1–3 extra fetches | ~one chunk |
| > 1 GB | Same; chunked into ~4 MB pieces, never materialised whole | ~one chunk |

Fallback browsers (Firefox, Safari) accumulate to Blob — this limits practical size to available RAM. Future work: Service Worker stream or Origin Private File System.
