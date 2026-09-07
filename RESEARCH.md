# Research Notes — Privacy-Preserving Browser-Based Autonomi Downloader

## Scope
Prove that a browser can download and decrypt public Autonomi data **without any server-side decryption**.

## Repositories Examined

| Repository | Version | Purpose |
|------------|---------|---------|
| `WithAutonomi/self_encryption` | 0.36.0 | Core convergent encryption / chunking |
| `WithAutonomi/ant-client` | 0.7.0 | Rust client library (`ant-core`) |
| `WithAutonomi/ant-sdk` | main | Multi-language SDKs via daemon/FFI |
| `WithAutonomi/ant-webex` | main | Browser extension (talks to local daemon) |

## Current Public Data Flow (from source code)

```
public address (32-byte BLAKE3 hash, hex 64 chars)
    ↓
data_map_fetch(address)
    → chunk_get(address)  → returns a raw chunk (encrypted DataMap)
    → rmp_serde::from_slice → DataMap
    ↓
DataMap { chunk_identifiers: Vec<ChunkInfo>, child: Option<usize> }
    ChunkInfo: { index, src_hash, dst_hash, src_size }
    ↓
For each chunk: chunk_get(dst_hash.0) → encrypted chunk bytes
    ↓
decrypt_chunk(index, encrypted_bytes, src_hashes, child_level)
    ↓
    1. get_pad_key_and_nonce(index, src_hashes, child_level)
         BLAKE3 KDF: derive_key("self_encryption/chunk/v2")
         context = src_hash || n_1_hash || n_2_hash || index_u64 || child_u64
         pad(52B) + key(32B) + nonce(12B)
    2. XOR obfuscation removal (pad)
    3. ChaCha20-Poly1305 decrypt
    4. Brotli decompress
    ↓
Concatenate in index order → original file bytes
```

## Encryption Details (verified in source)

- **Chunking**: File split into variable-size chunks (min 1B, max ~4 MiB default). Files < 12MB get exactly 3 chunks. Larger files get `ceil(size / 4MB)` chunks.
- **Key derivation**: Domain-separated BLAKE3 KDF (`self_encryption/chunk/v2`). Each chunk uses its own src_hash + two predecessor src_hashes + index + child_level. No external secret required — keys are derived from the DataMap itself.
- **Cipher**: ChaCha20-Poly1305 (pure Rust `chacha20poly1305` crate) with authenticated encryption.
- **Obfuscation**: XOR with a 52-byte pad derived from neighboring chunk hashes.
- **Compression**: Brotli (before encryption).
- **Content addressing**: `dst_hash` = BLAKE3 hash of encrypted chunk content (network address). `src_hash` = BLAKE3 hash of original plaintext chunk.
- **DataMap serialization**:
  - On-network (public): `rmp_serde::to_vec(data_map)` → **msgpack** with version byte.
  - Native crate: `DataMap::to_bytes()` → **bincode** with version byte.

## Shrunk (Child) DataMaps — VERIFIED

For large files the root DataMap is itself encrypted into wrapper chunks, producing a hierarchical map:
- `child = None` → root map (references actual file chunks).
- `child = Some(n)` → wrapper map whose chunks, when decrypted, yield a serialized parent DataMap.
- Resolution: recursively fetch wrapper chunks → decrypt (using child map's src_hashes + child level) → `DataMap::from_bytes` → repeat until root.

**Verification status**: The 100 MB and 1 GB test fixtures both have `child = 1`. The Node WASM harness and HTTP integration test both correctly resolve the shrunk map:
- 100 MB → 3 wrapper chunks → root DataMap with 26 chunks → 104,857,600 bytes verified.
- 1 GB → 3 wrapper chunks → root DataMap with 257 chunks → 1,073,741,824 bytes verified.

## JS/TS SDK & Browser Landscape

- `antd-js` (npm `antd`) is a **Node.js REST client** to a local `antd` daemon. It does NOT run in browsers.
- `ant-webex` browser extension fetches via `antd` running on localhost. No browser-side decryption.
- **No existing WASM or pure-browser decrypt implementation** was found in the current WithAutonomi repositories.
- **This POC** is the first verified browser-side decrypt path for public Autonomi data.

## Direct Browser → Autonomi Networking

**Not currently practical.** The Autonomi network uses QUIC/P2P via `saorsa-core`. Browsers cannot open raw UDP sockets or run a P2P DHT. No WebRTC or WebTransport bridge exists. The official extension explicitly requires a local daemon because "browser sandboxing and the network's post-quantum cryptography mean a small local daemon does the network work."

## WASM Compatibility Assessment

| Component | Current | WASM compatible? | Blocker / Fix |
|-----------|---------|------------------|---------------|
| DataMap parsing (bincode/msgpack) | Rust | **Yes** | None |
| Self-encryption (encrypt_chunk) | Rust | **Yes** | None |
| Chunk decryption (decrypt_chunk) | Rust | **Yes** | None |
| Reconstruction (streaming_decrypt) | Rust | **Yes** | None |
| Hash/integrity (blake3) | Rust | **Yes** | None |
| Parallel decrypt (`decrypt_sorted_set`) | Rust + `rayon` | **No** | Gated behind `#[cfg(not(target_arch = "wasm32"))]` |
| `getrandom` (via `rand`) | Rust | **No** (default) | Add `getrandom = { features = ["js"] }` |
| `tokio` (hard dep) | Rust | **No** (examples) | Remove from `[dependencies]` (only used in doc examples) |
| Network retrieval (`ant-core`) | Rust + tokio + QUIC | **No** | Infeasible in browser; use encrypted gateway |

**Conclusion**: `self_encryption` compiles to `wasm32-unknown-unknown` with ~5 lines of source changes and 1 Cargo.toml line.

## Key Findings from Live-Network Testing

- **`ant-cli` auto-connects** to the live Autonomi network (found 6 peers with zero configuration).
- **Live end-to-end verified**: Successfully downloaded a real 2.6 MB PNG file (`ayr.png`) from address `6e9668adff0258d5ab8ce8b7277c9409907ec6425c5cdc7cb9f2d55620a90622` via the browser gateway.
- **Peer-cache bootstrap is required**: `Client::connect(&[], config)` with empty bootstrap peers fails to reach the live network. The gateway must replicate `ant-cli`'s peer-cache logic (load cached bootstrap peers from disk, create P2P node, start, promote newly discovered peers).
- **Gateway route syntax**: axum 0.8 uses `{param}` not `:param` for path capture groups.
- **File System Access API requires user gesture**: `showSaveFilePicker()` must be called directly inside the click handler, before any `await`. The file picker is acquired immediately on click, then the DataMap is fetched and decryption proceeds.
- **Public DataMaps do not store the original filename**: The user must type the desired filename and extension in the browser's save dialog.
- **VPS deployment successful**: Deployed on Ubuntu 24.04 VPS with systemd + Cloudflare Tunnel. Gateway bootstraps with 50 cached peers, connects to 6 live peers, discovers 75 DHT peers.

## Key Unresolved Questions

1. **Real-network chunk retrieval latency**: Partially answered — live fetches work but per-chunk latency depends on peer distance and routing table health. The adaptive controller's retry logic (1-second settle + second close-group sweep) handles transient failures well.
2. **Browser streaming write for very large files**: File System Access API works on Chrome/Edge; Firefox and Safari require Blob fallback (RAM-limited). Service-Worker-based streaming (e.g. StreamSaver) is a future optimisation.
3. **Gateway trust model**: The gateway could censor or rate-limit. A future design could use multiple gateway mirrors or optimistic concurrent fetches.
