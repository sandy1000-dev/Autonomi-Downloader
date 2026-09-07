//! Browser (wasm32-unknown-unknown) bindings for decrypting public Autonomi data.
//!
//! This POC exposes the minimum surface needed to prove that a browser can
//! decrypt and reconstruct an Autonomi file locally, using the *current*
//! `self_encryption` crate (vendored copy) compiled to WebAssembly.
//!
//! The design intentionally keeps decryption per-chunk so the browser can
//! process arbitrarily large files incrementally (never needing full-file RAM):
//! the caller (JavaScript) fetches each encrypted chunk (e.g. via a gateway),
//! hands it to [`decrypt_chunk_wasm`], and streams the returned plaintext out.
//!
//! Integrity is preserved exactly as in the native path:
//! * `dst_hash` == BLAKE3(encrypted chunk) == the chunk's network address
//! * `src_hash` == BLAKE3(decrypted/decompressed chunk)
//! * ChaCha20-Poly1305 AEAD rejects any tampered/compromised ciphertext.

use self_encryption::{decrypt_chunk, DataMap};
use wasm_bindgen::prelude::*;
use xor_name::XorName;

fn hex_to_xorname(s: &str) -> Result<XorName, JsValue> {
    let mut b = [0u8; 32];
    hex::decode_to_slice(s, &mut b).map_err(|e| {
        JsValue::from_str(&format!("invalid src_hash hex '{s}': {e}"))
    })?;
    Ok(XorName(b))
}

fn xorname_to_hex(n: &XorName) -> String {
    hex::encode(n.0)
}

/// Deserialise a public Autonomi DataMap from its on-network representation
/// (msgpack, as produced by `Client::data_map_store`) and return a JSON string:
/// `{ original_file_size, child, chunks: [{ index, src_hash, dst_hash, src_size }] }`.
#[wasm_bindgen]
pub fn datamap_from_msgpack(msgpack_bytes: &[u8]) -> Result<String, JsValue> {
    let dm: DataMap =
        rmp_serde::from_slice(msgpack_bytes).map_err(|e| JsValue::from_str(&e.to_string()))?;
    datamap_to_json_string(&dm)
}

/// Deserialise a DataMap from self_encryption's native bincode format
/// (`DataMap::to_bytes`). For reference/testing; the network uses msgpack.
#[wasm_bindgen]
pub fn datamap_from_bincode(bincode_bytes: &[u8]) -> Result<String, JsValue> {
    let dm: DataMap = self_encryption::DataMap::from_bytes(bincode_bytes)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    datamap_to_json_string(&dm)
}

fn datamap_to_json_string(dm: &DataMap) -> Result<String, JsValue> {
    let infos = dm.infos();
    let chunks: Vec<serde_json::Value> = infos
        .iter()
        .map(|c| {
            serde_json::json!({
                "index": c.index,
                "src_hash": xorname_to_hex(&c.src_hash),
                "dst_hash": xorname_to_hex(&c.dst_hash),
                "src_size": c.src_size,
            })
        })
        .collect();
    let obj = serde_json::json!({
        "original_file_size": dm.original_file_size(),
        "child": dm.child(),
        "chunks": chunks,
    });
    serde_json::to_string(&obj).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Extract the ordered list of `src_hash` hex strings from a msgpack DataMap.
/// Pass this once to [`decrypt_chunk_wasm`] as `src_hashes_json`.
#[wasm_bindgen]
pub fn extract_src_hashes(msgpack_bytes: &[u8]) -> Result<String, JsValue> {
    let dm: DataMap =
        rmp_serde::from_slice(msgpack_bytes).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let hashes: Vec<String> = dm
        .infos()
        .iter()
        .map(|c| xorname_to_hex(&c.src_hash))
        .collect();
    serde_json::to_string(&hashes).map_err(|e| JsValue::from_str(&e.to_string()))
}

fn parse_src_hashes(json: &str) -> Result<Vec<XorName>, JsValue> {
    let v: Vec<String> = serde_json::from_str(json)
        .map_err(|e| JsValue::from_str(&format!("src_hashes JSON: {e}")))?;
    v.iter().map(|s| hex_to_xorname(s)).collect()
}

/// Decrypt and decompress a single chunk. `src_hashes_json` is the JSON array
/// from [`extract_src_hashes`] (all src hashes in index order).
/// Returns the plaintext chunk bytes for the given `chunk_index`.
#[wasm_bindgen]
pub fn decrypt_chunk_wasm(
    chunk_index: usize,
    encrypted_content: &[u8],
    src_hashes_json: &str,
    child_level: usize,
) -> Result<Box<[u8]>, JsValue> {
    let src_hashes = parse_src_hashes(src_hashes_json)?;
    let enc = bytes::Bytes::copy_from_slice(encrypted_content);
    let decrypted = decrypt_chunk(chunk_index, &enc, &src_hashes, child_level)
        .map_err(|e| JsValue::from_str(&format!("decrypt failed: {e}")))?;
    Ok(decrypted.to_vec().into_boxed_slice())
}

/// Decrypt every chunk referenced in a msgpack DataMap and concatenate the
/// plaintext in index order. Convenience helper for native testing / small
/// files. Not exported to JS (wasm-bindgen cannot take `Vec<Vec<u8>>`); the
/// browser path uses [`decrypt_chunk_wasm`] per chunk + streaming.
pub fn decrypt_all(
    msgpack_bytes: &[u8],
    encrypted_chunks: Vec<Vec<u8>>,
) -> Result<Vec<u8>, JsValue> {
    let dm: DataMap =
        rmp_serde::from_slice(msgpack_bytes).map_err(|e| JsValue::from_str(&e.to_string()))?;
    if dm.is_child() {
        return Err(JsValue::from_str(
            "decrypt_all does not support shrunk (child) DataMaps; resolve in JS first",
        ));
    }
    let child_level = dm.child().unwrap_or(0);
    let src_hashes: Vec<XorName> = dm.infos().iter().map(|c| c.src_hash).collect();
    let mut out: Vec<u8> = Vec::new();
    for (i, enc) in encrypted_chunks.iter().enumerate() {
        let enc = bytes::Bytes::copy_from_slice(enc);
        let decrypted = decrypt_chunk(i, &enc, &src_hashes, child_level)
            .map_err(|e| JsValue::from_str(&format!("chunk {i} decrypt failed: {e}")))?;
        out.extend_from_slice(&decrypted);
    }
    Ok(out)
}

/// BLAKE3 content hash (hex) of `bytes` — used to verify integrity:
/// `content_hash(encrypted) == dst_hash` and `content_hash(decrypted) == src_hash`.
#[wasm_bindgen]
pub fn content_hash(bytes: &[u8]) -> String {
    xorname_to_hex(&self_encryption::hash::content_hash(bytes))
}

