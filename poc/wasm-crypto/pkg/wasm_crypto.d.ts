/* tslint:disable */
/* eslint-disable */

/**
 * BLAKE3 content hash (hex) of `bytes` — used to verify integrity:
 * `content_hash(encrypted) == dst_hash` and `content_hash(decrypted) == src_hash`.
 */
export function content_hash(bytes: Uint8Array): string;

/**
 * Deserialise a DataMap from self_encryption's native bincode format
 * (`DataMap::to_bytes`). For reference/testing; the network uses msgpack.
 */
export function datamap_from_bincode(bincode_bytes: Uint8Array): string;

/**
 * Deserialise a public Autonomi DataMap from its on-network representation
 * (msgpack, as produced by `Client::data_map_store`) and return a JSON string:
 * `{ original_file_size, child, chunks: [{ index, src_hash, dst_hash, src_size }] }`.
 */
export function datamap_from_msgpack(msgpack_bytes: Uint8Array): string;

/**
 * Decrypt and decompress a single chunk. `src_hashes_json` is the JSON array
 * from [`extract_src_hashes`] (all src hashes in index order).
 * Returns the plaintext chunk bytes for the given `chunk_index`.
 */
export function decrypt_chunk_wasm(chunk_index: number, encrypted_content: Uint8Array, src_hashes_json: string, child_level: number): Uint8Array;

/**
 * Extract the ordered list of `src_hash` hex strings from a msgpack DataMap.
 * Pass this once to [`decrypt_chunk_wasm`] as `src_hashes_json`.
 */
export function extract_src_hashes(msgpack_bytes: Uint8Array): string;
