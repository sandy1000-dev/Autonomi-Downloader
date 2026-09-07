# Security & Privacy — Browser-Based Autonomi Downloader

## Hard Invariant

> **The gateway/server MUST NOT receive the plaintext file.**

This is enforced architecturally: the gateway only serves content-addressed encrypted chunks and the msgpack DataMap. Decryption and reconstruction happen exclusively in the browser via a WebAssembly module compiled from the upstream `self_encryption` crate.

## Privacy Model

### What the gateway CANNOT see
- **Plaintext file content** — it only serves encrypted bytes.
- **Encryption keys** — keys are derived from `src_hashes` inside the DataMap using the BLAKE3 KDF; the gateway never receives the DataMap in a form it can use for decryption (it receives the encrypted DataMap chunk, but cannot derive keys without the root DataMap's src_hashes, which are only available after resolving child maps — all done in the browser).
- **User accounts, wallets, passwords** — none are required for public data.

### What the gateway CAN see (metadata)
- User's IP address
- Requested public Autonomi address
- Individual chunk addresses (`dst_hash`)
- Request timing and approximate download duration
- Approximate file size (from total encrypted bytes served and chunk count)
- Network traffic volume

**Mitigation**: The design minimises persistent state (no accounts, no cookies, no analytics). A future enhancement could use a CDN or Tor transport to obscure the IP↔address correlation.

## Integrity

Autonomi's existing cryptographic integrity mechanisms are used directly — no weaker alternative is introduced.

1. **Pre-decrypt integrity**: `content_hash(encrypted_chunk) == dst_hash` (BLAKE3 content addressing). A malicious gateway cannot substitute a different encrypted chunk without changing its address.
2. **AEAD integrity**: ChaCha20-Poly1305 fails decryption if the ciphertext is tampered with.
3. **Post-decrypt integrity**: `content_hash(decrypted_chunk) == src_hash`. Verifies the decrypted plaintext matches the original chunk.
4. **Size integrity**: Sum of `src_size` fields equals `original_file_size` from the DataMap.

## Threat Scenarios

### Malicious / Compromised Gateway
- **Can it read the file?** **No.** It only has encrypted chunks and the DataMap. Without the root DataMap's src_hashes, it cannot derive the ChaCha20-Poly1305 keys.
- **Can it modify the file?** Only by withholding or substituting chunks. Any substitution fails the `dst_hash` check (content addressing) or the AEAD tag (ChaCha20-Poly1305).
- **Can it inject malicious chunks?** Only chunks whose BLAKE3 hash matches a `dst_hash` in the DataMap would pass the pre-decrypt check. Because the DataMap itself is content-addressed by its public address, the gateway cannot alter the DataMap without the user noticing (the address would mismatch). The browser validates the DataMap address against the user-supplied address.
- **Can it perform a man-in-the-middle attack?** The browser-to-gateway transport should be HTTPS. Without TLS, an active network attacker could substitute traffic, but the same integrity checks (dst_hash, AEAD) would detect tampering.

### Malicious Autonomi Data
- The browser must not blindly trust:
  - `file_size` — validated against sum of `src_size`.
  - `chunk_count` — validated against actual chunk retrieval.
  - `chunk_addresses` — validated by content_hash checks.
  - `filename` — must be sanitised before display/download.
  - `MIME type` — should be derived from magic bytes or the file extension, not the DataMap (which has no MIME field for public data anyway).
- **Memory safety**: `src_hashes` JSON parsing and chunk indexing are bounded by the DataMap's chunk count. No unbounded arrays are allocated from untrusted input.

### Browser Security
- The application is a static page + WASM. No server-side rendering that could inject XSS.
- No cookies, localStorage, or IndexedDB are used for file data (only for UI state if any).
- The `File System Access API` write path is gated by a user-initiated `showSaveFilePicker`, preventing drive-by writes.
- The original filename is **not stored in the public DataMap**. The only way to infer file type is from the decrypted content (magic bytes) or the extension the user chooses in the save dialog.

## Production Deployment Notes

When deploying the gateway on a VPS:
- The peer cache file (`client_peer_cache.json`) contains bootstrap peer addresses. It should be copied from a machine that has successfully connected to the Autonomi network.
- The gateway runs as a systemd service with auto-restart on failure.
- Cloudflare Tunnel provides HTTPS without opening firewall ports, but adds Cloudflare as a traffic observer.
- The gateway logs contain peer IDs and connection metadata. Rotate logs regularly.

## Metadata Correlation Risk

The gateway can correlate:
```
IP address + Autonomi address + download time
```
This reveals *that* a user downloaded *something* from a specific address at a specific time. It does **not** reveal *what* the file contains. For highly sensitive use cases, pairing this downloader with a privacy network (VPN/Tor) is recommended.
