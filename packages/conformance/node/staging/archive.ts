import { zstdDecompressSync } from 'node:zlib';

const BLOCK = 512;
/** A UI bundle unpacks to a few MiB; anything far beyond is not one, and decompressing it would only use memory. */
export const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;

export type FirstEntry =
    | { readonly kind: 'entry'; readonly path: string; readonly bytes: Uint8Array }
    | { readonly kind: 'invalid'; readonly reason: string };

/**
 * The first entry of a ustar `tar.zst`: the UI archive keeps its manifest there, so nothing else needs unpacking.
 * Only a regular file counts; the release tooling never writes anything else first.
 */
export function readFirstEntry(archive: Uint8Array): FirstEntry {
    let tar: Uint8Array;
    try {
        tar = zstdDecompressSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES });
    } catch {
        return { kind: 'invalid', reason: 'not a zstd frame' };
    }
    if (tar.length < BLOCK) return { kind: 'invalid', reason: 'the tar archive is truncated' };
    const header = tar.subarray(0, BLOCK);
    if (field(header, 257, 5) !== 'ustar') return { kind: 'invalid', reason: 'not a ustar archive' };
    const type = field(header, 156, 1);
    if (type !== '0' && type !== '') return { kind: 'invalid', reason: 'the first entry is not a regular file' };
    const size = Number.parseInt(field(header, 124, 12).trim(), 8);
    if (!Number.isSafeInteger(size) || BLOCK + size > tar.length) {
        return { kind: 'invalid', reason: 'the first entry is truncated' };
    }
    const prefix = field(header, 345, 155);
    const name = field(header, 0, 100);
    return {
        kind: 'entry',
        path: prefix === '' ? name : `${prefix}/${name}`,
        bytes: tar.subarray(BLOCK, BLOCK + size),
    };
}

function field(block: Uint8Array, offset: number, length: number): string {
    const raw = block.subarray(offset, offset + length);
    const end = raw.indexOf(0);
    return new TextDecoder().decode(end === -1 ? raw : raw.subarray(0, end));
}
