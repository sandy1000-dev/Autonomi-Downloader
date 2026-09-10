# Autonomi Browser Downloader

> **Zero-install, privacy-preserving downloads from the Autonomi decentralized storage network.  The server never sees your decrypted file.

---

## What is this?

Experimental browser-based downloader / proof of concept

This is a proof-of-concept web downloader for [Autonomi](https://autonomi.com), a decentralized, permanent data network. Anyone can store files on Autonomi; they receive a public address (a 64-character hex string) that others can use to retrieve the data.

**The problem this project solves:**
- Existing Autonomi tools require installing a local daemon or CLI.
- Existing web gateways decrypt files on the server — the operator can read your data.

**This project's approach:**
- A lightweight gateway fetches **only encrypted chunks** from the Autonomi network.
- Your browser receives those encrypted bytes and decrypts/reconstructs the file locally using a WebAssembly module.
- The gateway operator cannot read your files. No installation required. No accounts.

> ⚠️ **Status:** Experimental proof-of-concept. Verified working for public data from 1 KB to 1 GB on the live Autonomi network.

---

## What is Autonomi? (30-second primer)

[Autonomi](https://autonomi.com) is a peer-to-peer storage network where:
- Files are split into encrypted chunks and distributed across the network.
- Data is **content-addressed** — the address of a file is derived from its contents.
- Storage is pay-once; reads are free.
- Public data can be retrieved by anyone who knows its address.

To learn more, see the [Autonomi documentation](https://docs.autonomi.com) or the [official SDK](https://github.com/WithAutonomi/ant-sdk).

---

## Repository Overview

| Directory | What it is | Origin |
|-----------|-----------|--------|
| [`poc/`](poc/) | **Original work** — the browser downloader proof-of-concept | This project |
| [`poc/live-gateway/`](poc/live-gateway/) | Rust Axum server that bridges the browser to the live Autonomi P2P network | This project |
| [`poc/wasm-crypto/`](poc/wasm-crypto/) | WebAssembly module for client-side decryption (`wasm-bindgen` + `self_encryption`) | This project |
| [`poc/web/`](poc/web/) | Browser UI (HTML/JS) that orchestrates fetch → WASM decrypt → disk stream | This project |
| [`poc/cli/`](poc/cli/) | Native reference CLI for generating test fixtures | This project |
| [`ant-client/`](ant-client/) | Vendored fork of `WithAutonomi/ant-client` — unified CLI + `ant-core` library | Upstream fork |
| [`ant-sdk/`](ant-sdk/) | Vendored fork of `WithAutonomi/ant-sdk` — multi-language SDKs | Upstream fork |
| [`self_encryption/`](self_encryption/) | Vendored fork of `WithAutonomi/self_encryption` — convergent encryption crate | Upstream fork |

The vendored crates have **minimal patches** to support WASM compilation and to expose the APIs needed by the gateway. See [`RESEARCH.md`](RESEARCH.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md) for details.

---

## Quick Start — Try it on the Live Network

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- A machine with **4 GB RAM** (or 2 GB + 2 GB swap for compilation)
- Ubuntu 22.04+ / Debian 12+ / macOS (Linux recommended for deployment)

### 1. Build & run the live gateway

```bash
cd poc/live-gateway
cargo run --release
```

Wait for the gateway to bootstrap into the live Autonomi network:

```
Connected to Autonomi network (N peers)
Gateway listening on http://localhost:8099
```

### 2. Open the browser page

Open `http://localhost:8099` in **Chrome or Edge** (required for the File System Access API, which enables large-file streaming). Paste a public Autonomi address and click **Download**.

> **Note:** Autonomi public uploads do not store the original filename. You will need to type the desired filename and extension in the save dialog (e.g. `photo.png`). The suggested name defaults to `autonomi-download.bin`.

### 3. Verify the gateway is healthy

```bash
curl -s http://localhost:8099/health | jq
# → {"connected_peers": 6, "status": "ready"}
```

---

## Quick Start — Local Testing (No Live Network)

For development and testing with local fixtures instead of the live network:

### 1. Build the native reference tool & generate fixtures

```bash
cd poc/cli
cargo build --release

# Generate test files (1 KB, 1 MB, 10 MB, 100 MB, 1 GB)
mkdir -p ../fixtures
./target/release/gen 1024      ../fixtures/1kb
./target/release/gen 1048576   ../fixtures/1mb
./target/release/gen 10485760  ../fixtures/10mb
./target/release/gen 104857600 ../fixtures/100mb
./target/release/gen 1073741824 ../fixtures/1gb
```

### 2. Build the WASM module

```bash
cd poc/wasm-crypto
cargo build --target wasm32-unknown-unknown --release
wasm-bindgen --target web --out-dir ../web/wasm \
  target/wasm32-unknown-unknown/release/wasm_crypto.wasm
```

### 3. Start the local encrypted gateway

```bash
cd poc/web
node gateway.cjs ../fixtures/1mb ../fixtures/100mb --port 8099
```

The gateway prints the public address for each registered fixture. It serves **only encrypted bytes** — the serve log proves this.

### 4. Run automated tests

```bash
# Native round-trip (proves vendored crate matches upstream)
cd poc/wasm-crypto && cargo test

# Node WASM harness (proves actual wasm artifact decrypts correctly)
cd poc/web && node test-node.cjs \
  ../fixtures/1kb ../fixtures/1mb ../fixtures/10mb \
  ../fixtures/100mb ../fixtures/1gb

# HTTP integration test (proves gateway + wasm + fetch flow)
node test-http.cjs http://localhost:8099 <address> <expected_sha> <size>

# Headless browser end-to-end test
./run-browser-test.sh

---

## How it Works

```
Browser
  │ HTTPS
  ▼
Gateway  ──→  ant-core  ──→  Autonomi network (live peers)
  │                                              │
  │ GET /datamap/{addr}  (msgpack DataMap)       │
  │ GET /chunk/{addr}    (encrypted chunk bytes) │
  │ GET /health          (peer count & status)   │
  ▼                                              ▼
Browser JS orchestrator
  │
  │ calls WASM (self_encryption)
  ▼
Per-chunk decrypt (ChaCha20-Poly1305 + Brotli)
  │
  ▼
File System Access API / Blob → local file
```

1. The browser asks the gateway for a **DataMap** (metadata about how the file is chunked).
2. The gateway fetches this from the Autonomi P2P network and returns it raw — it never decrypts anything.
3. The browser's JavaScript orchestrator resolves any nested/shrunk DataMaps, then fetches each encrypted chunk.
4. Each chunk is passed to a **WebAssembly module** compiled from the `self_encryption` crate, which decrypts it locally.
5. Decrypted bytes are streamed directly to disk via the **File System Access API** (Chrome/Edge) or accumulated into a Blob (Firefox/Safari).

> **Key invariant:** The gateway never decrypts and never stores plaintext. It is a dumb encrypted transport.

---

## Browser Compatibility

| Browser | File size limit | Notes |
|---------|----------------|-------|
| **Chrome / Edge** | Unlimited (disk space) | Uses File System Access API — streams directly to disk. User must type filename in save dialog. |
| **Firefox / Safari** | ~available RAM | Falls back to Blob accumulation. |

---

## Deployment

The gateway has been successfully deployed on an Ubuntu 24.04 VPS and is serving real users.

### VPS Requirements
- **OS**: Ubuntu 22.04+ or Debian 12+
- **CPU**: 2 vCPU (compilation needs swap)
- **RAM**: 2 GB minimum (add 2 GB swap for compilation)
- **Disk**: 20 GB+ (Rust build artifacts are large)
- **Network**: UDP ports open (for P2P QUIC connections)

### Deployment Steps

1. **Prepare the server:**
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential pkg-config libssl-dev curl

# Add 2GB swap (compilation needs more than 2GB RAM)
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# Install wasm-bindgen (needed to build WASM artifact)
cargo install wasm-bindgen-cli
```

2. **Build the project:**
```bash
git clone <repo-url>
cd <repo>/poc/wasm-crypto
cargo build --target wasm32-unknown-unknown --release
wasm-bindgen --target web --out-dir ../web/wasm \
  target/wasm32-unknown-unknown/release/wasm_crypto.wasm

cd ../live-gateway
cargo build --release
```

3. **Copy peer cache from a working machine:**
The gateway needs a `client_peer_cache.json` file to bootstrap into the Autonomi network. Copy it from a machine that has successfully connected:
```bash
scp ~/.local/share/ant/client_peer_cache.json user@vps:/home/user/
```

4. **Create systemd service** (`/etc/systemd/system/autonomi-gateway.service`):
```ini
[Unit]
Description=Autonomi Encrypted Gateway
After=network.target

[Service]
Type=simple
User=autonomi
WorkingDirectory=/home/autonomi/poc/live-gateway
ExecStart=/home/autonomi/poc/live-gateway/target/release/live-gateway
Environment="RUST_LOG=info"
Environment="STATIC_DIR=/home/autonomi/poc/web"
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

5. **Start the service:**
```bash
sudo systemctl daemon-reload
sudo systemctl enable autonomi-gateway
sudo systemctl start autonomi-gateway
sudo journalctl -u autonomi-gateway -f
```

6. **(Optional) Cloudflare Tunnel for HTTPS:**
```bash
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
sudo cloudflared service install <your-token>
```

### Troubleshooting

| Issue | Fix |
|-------|-----|
| `cargo` OOM during build | Ensure swap is active: `free -h`. If RAM < 4 GB, increase swap to 4 GB. |
| Gateway shows `bootstrapping` / 0 peers | Copy `client_peer_cache.json` from a working machine. Verify UDP ports are open. |
| `Permission denied` on VPS | Ensure the `autonomi` user owns the binary and cache file. |
| `Address already in use` | `kill $(lsof -t -i:8099)` then restart. |
| Gateway will not start | Check `sudo journalctl -u autonomi-gateway -f` for errors. |


---

## Documentation

| File | What's inside |
|------|---------------|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Detailed architecture, data flow diagrams, component breakdown |
| [`SECURITY.md`](SECURITY.md) | Privacy model, threat model, integrity guarantees, metadata exposure |
| [`RESEARCH.md`](RESEARCH.md) | Deep-dive into Autonomi internals, encryption details, WASM feasibility assessment |
| [`ROADMAP.md`](ROADMAP.md) | Phased development plan (what's done, what's next) |
| [`AGENTS.md`](AGENTS.md) | **Context for AI agents** — repo topology, build map, constraints, file guide |

---

## Key Results

- ✅ **`self_encryption` compiles to WASM** with only 4 minimal patches (rayon gating, test_helpers gating, tokio removal, `getrandom` js feature).
- ✅ **Files from 1 KB to 1 GB** verified with exact SHA-256 matches across native, Node WASM, HTTP integration, and headless browser tests.
- ✅ **Shrunk (child) DataMaps** correctly resolved in the browser (verified at 100 MB and 1 GB).
- ✅ **Live network verified end-to-end**: Successfully downloaded a real 2.6 MB PNG from the live Autonomi network through the browser.
- ✅ **VPS deployment verified**: Ubuntu 24.04 + systemd + Cloudflare Tunnel, serving real users.

---

## Contributing

This is a personal proof-of-concept. If you'd like to experiment with it, open an issue or PR. The codebase is permissively licensed to match upstream Autonomi crates.

## License

Licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or http://www.apache.org/licenses/LICENSE-2.0)
- MIT license ([LICENSE-MIT](LICENSE-MIT) or http://opensource.org/licenses/MIT)

at your option.
