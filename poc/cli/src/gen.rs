//! Native reference tool — generates Autonomi self-encrypted test fixtures.
//!
//! Uses the *pristine, unmodified* upstream `self_encryption` crate so we can
//! prove that the vendored/WASM decode path produces byte-identical output.
//!
//! Usage: `gen <size_bytes> <output_dir>`
//!
//! Writes into `<output_dir>`:
//!   * original.bin            - the plaintext test file
//!   * original.sha256         - hex SHA-256 of original.bin (expected hash)
//!   * datamap.msgpack         - DataMap serialized with msgpack (as the network stores it)
//!   * datamap.bincode         - DataMap serialized with bincode (native DataMap::to_bytes)
//!   * chunks/<dst_hash_hex>   - one file per encrypted chunk (content-addressed)

use anyhow::Result;
use self_encryption::{encrypt, test_helpers::random_bytes};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: gen <size_bytes> <output_dir>");
        std::process::exit(2);
    }
    let size: usize = args[1].parse()?;
    let dir = PathBuf::from(&args[2]);
    fs::create_dir_all(dir.join("chunks"))?;

    let original = random_bytes(size);

    // Pre-encryption content hash (src) comes from the DataMap itself, so we only
    // need SHA-256 of the raw file for independent verification.
    let mut hasher = Sha256::new();
    hasher.update(&original);
    let sha = hex::encode(hasher.finalize());
    fs::write(dir.join("original.bin"), &original)?;
    fs::write(dir.join("original.sha256"), format!("{sha}\n"))?;

    let (data_map, encrypted_chunks) = encrypt(original)?;

    // msgpack serialization — exactly what `Client::data_map_store` does on-network.
    let dm_msgpack = rmp_serde::to_vec(&data_map)?;
    fs::write(dir.join("datamap.msgpack"), &dm_msgpack)?;

    // bincode serialization — native DataMap::to_bytes format.
    let dm_bincode = data_map.to_bytes()?;
    fs::write(dir.join("datamap.bincode"), &dm_bincode)?;

    for chunk in &encrypted_chunks {
        let address = self_encryption::hash::content_hash(&chunk.content);
        fs::write(dir.join("chunks").join(format!("{}.chunk", hex::encode(address.0))), &chunk.content)?;
    }

    println!("Generated {} bytes into {}", size, dir.display());
    println!("  chunks:           {}", encrypted_chunks.len());
    println!("  original SHA-256: {sha}");
    println!("  DataMap msgpack:  {} bytes", dm_msgpack.len());
    println!("  DataMap bincode:  {} bytes", dm_bincode.len());
    println!("  child (shrunk)?   {}", data_map.child().unwrap_or(0));
    Ok(())
}
