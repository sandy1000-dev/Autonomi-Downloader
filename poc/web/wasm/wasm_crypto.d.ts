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

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly content_hash: (a: number, b: number) => [number, number];
    readonly datamap_from_bincode: (a: number, b: number) => [number, number, number, number];
    readonly datamap_from_msgpack: (a: number, b: number) => [number, number, number, number];
    readonly decrypt_chunk_wasm: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly extract_src_hashes: (a: number, b: number) => [number, number, number, number];
    readonly BrotliDecoderCreateInstance: (a: number, b: number, c: number) => number;
    readonly BrotliDecoderDecompress: (a: number, b: number, c: number, d: number) => number;
    readonly BrotliDecoderDecompressPrealloc: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly BrotliDecoderDecompressStream: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly BrotliDecoderDecompressStreaming: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly BrotliDecoderDecompressWithReturnInfo: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly BrotliDecoderDestroyInstance: (a: number) => void;
    readonly BrotliDecoderErrorString: (a: number) => number;
    readonly BrotliDecoderFreeU8: (a: number, b: number, c: number) => void;
    readonly BrotliDecoderFreeUsize: (a: number, b: number, c: number) => void;
    readonly BrotliDecoderGetErrorCode: (a: number) => number;
    readonly BrotliDecoderGetErrorString: (a: number) => number;
    readonly BrotliDecoderHasMoreOutput: (a: number) => number;
    readonly BrotliDecoderIsFinished: (a: number) => number;
    readonly BrotliDecoderIsUsed: (a: number) => number;
    readonly BrotliDecoderMallocU8: (a: number, b: number) => number;
    readonly BrotliDecoderMallocUsize: (a: number, b: number) => number;
    readonly BrotliDecoderSetParameter: (a: number, b: number, c: number) => void;
    readonly BrotliDecoderTakeOutput: (a: number, b: number) => number;
    readonly BrotliDecoderVersion: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
