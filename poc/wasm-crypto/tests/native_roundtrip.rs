//! Native round-trip test: decrypt the fixtures (produced by the *pristine*
//! self_encryption crate) using the wasm-crypto crate's logic, and verify the
//! SHA-256 matches the original. This proves the vendored/WASM path is
//! byte-identical to the upstream implementation before we even ship the .wasm.

use std::fs;
use std::path::PathBuf;
use sha2::{Digest, Sha256};

fn fixture_roundtrip(fixture_dir: &str) -> Result<(), String> {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("fixtures").join(fixture_dir);

    let dm = fs::read(base.join("datamap.msgpack")).map_err(|e| e.to_string())?;
    let expected_sha = fs::read_to_string(base.join("original.sha256"))
        .map_err(|e| e.to_string())?
        .trim()
        .to_string();

    // Parse the DataMap to learn chunk order (dst_hash) and src_hashes.
    let dm_json = wasm_crypto::datamap_from_msgpack(&dm).map_err(|e| format!("{e:?}"))?;
    let dm_value: serde_json::Value =
        serde_json::from_str(&dm_json).map_err(|e| e.to_string())?;
    let chunks = dm_value["chunks"].as_array().ok_or("no chunks")?.clone();

    // Read each encrypted chunk file, ordered by DataMap index via dst_hash.
    let mut encrypted: Vec<Vec<u8>> = Vec::new();
    for c in &chunks {
        let dst = c["dst_hash"].as_str().ok_or("no dst_hash")?;
        let data = fs::read(base.join("chunks").join(format!("{dst}.chunk")))
            .map_err(|e| format!("read chunk {dst}: {e}"))?;
        // Optional integrity check: content_hash(encrypted) == dst_hash.
        let hash = wasm_crypto::content_hash(&data);
        assert_eq!(hash, dst, "chunk {dst} content-addressing mismatch");
        encrypted.push(data);
    }

    // All-at-once decrypt.
    let plaintext = wasm_crypto::decrypt_all(&dm, encrypted).map_err(|e| format!("{e:?}"))?;

    let mut hasher = Sha256::new();
    hasher.update(&plaintext);
    let sha = hex::encode(hasher.finalize());
    assert_eq!(sha, expected_sha, "SHA-256 mismatch for {fixture_dir}");
    assert_eq!(plaintext.len() as u64, fs::metadata(base.join("original.bin")).map_err(|e| e.to_string())?.len());

    // Also validate the incremental per-chunk API + integrity (src_hash check).
    let src_hashes = wasm_crypto::extract_src_hashes(&dm).map_err(|e| format!("{e:?}"))?;
    let mut recon: Vec<u8> = Vec::new();
    for (i, c) in chunks.iter().enumerate() {
        let dst = c["dst_hash"].as_str().ok_or("no dst_hash")?;
        let enc = fs::read(base.join("chunks").join(format!("{dst}.chunk"))).map_err(|e| e.to_string())?;
        let dec = wasm_crypto::decrypt_chunk_wasm(i, &enc, &src_hashes, 0).map_err(|e| format!("{e:?}"))?;
        // Post-decrypt integrity: content_hash(decrypted) == src_hash.
        let src = c["src_hash"].as_str().ok_or("no src_hash")?;
        assert_eq!(wasm_crypto::content_hash(&dec), src, "src_hash mismatch at chunk {i}");
        recon.extend_from_slice(&dec);
    }
    let mut hasher2 = Sha256::new();
    hasher2.update(&recon);
    let sha2 = hex::encode(hasher2.finalize());
    assert_eq!(sha2, expected_sha, "incremental SHA-256 mismatch for {fixture_dir}");

    println!("  OK {fixture_dir}: {sha}");
    Ok(())
}

#[test]
fn roundtrip_1kb() {
    fixture_roundtrip("1kb").unwrap();
}

#[test]
fn roundtrip_1mb() {
    fixture_roundtrip("1mb").unwrap();
}

#[test]
fn roundtrip_10mb() {
    fixture_roundtrip("10mb").unwrap();
}
