/**
 * Writes UI archives, including the unsafe ones a loader must refuse. Unlike the release tooling's writer this one
 * checks nothing: a check decides what goes in, `../` and links included.
 */
export type ArchiveEntry =
    | { readonly kind: 'file'; readonly path: string; readonly bytes: Uint8Array }
    | { readonly kind: 'directory'; readonly path: string }
    | { readonly kind: 'symlink' | 'hardlink'; readonly path: string; readonly target: string };

const BLOCK = 512;
const NAME_BYTES = 100;
const TYPE_FLAG = { file: '0', hardlink: '1', symlink: '2', directory: '5' } as const;

const ascii = new TextEncoder();

function put(block: Uint8Array, offset: number, length: number, text: string): void {
    const bytes = ascii.encode(text);
    if (bytes.length > length) throw new RangeError(`tar field too long: ${text}`);
    block.set(bytes, offset);
}

function octal(value: number, length: number): string {
    return value.toString(8).padStart(length - 1, '0');
}

function header(entry: ArchiveEntry, size: number): Uint8Array {
    const block = new Uint8Array(BLOCK);
    if (ascii.encode(entry.path).length > NAME_BYTES) throw new RangeError(`tar path too long: ${entry.path}`);
    put(block, 0, NAME_BYTES, entry.path);
    put(block, 100, 8, octal(entry.kind === 'directory' ? 0o755 : 0o644, 8));
    put(block, 108, 8, octal(0, 8));
    put(block, 116, 8, octal(0, 8));
    put(block, 124, 12, octal(size, 12));
    put(block, 136, 12, octal(0, 12));
    put(block, 156, 1, TYPE_FLAG[entry.kind]);
    if (entry.kind === 'symlink' || entry.kind === 'hardlink') put(block, 157, NAME_BYTES, entry.target);
    put(block, 257, 6, 'ustar\0');
    put(block, 263, 2, '00');
    block.fill(0x20, 148, 156);
    const sum = block.reduce((total, byte) => total + byte, 0);
    put(block, 148, 8, `${octal(sum, 7)}\0`);
    return block;
}

/** A ustar archive with the entries in the given order. */
export function writeArchiveTar(entries: readonly ArchiveEntry[]): Uint8Array<ArrayBuffer> {
    const chunks: Uint8Array[] = [];
    for (const entry of entries) {
        const bytes = entry.kind === 'file' ? entry.bytes : new Uint8Array(0);
        chunks.push(header(entry, bytes.length), bytes, new Uint8Array((BLOCK - (bytes.length % BLOCK)) % BLOCK));
    }
    chunks.push(new Uint8Array(2 * BLOCK));
    return concat(chunks);
}

const ZSTD_MAGIC = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd);
// Single segment with an 8-byte content size: no window descriptor, and any length fits.
const ZSTD_FRAME_DESCRIPTOR = 0xe0;
const ZSTD_MAX_BLOCK = 128 * 1024;

/**
 * One zstd frame of raw (stored) blocks (RFC 8878): every conforming decoder reads it, and it needs no compressor,
 * so the suite stays portable. The loader cannot tell it from a compressed archive by anything but its size.
 */
export function zstdStore(data: Uint8Array): Uint8Array<ArrayBuffer> {
    const size = new Uint8Array(8);
    new DataView(size.buffer).setBigUint64(0, BigInt(data.length), true);
    const chunks: Uint8Array[] = [ZSTD_MAGIC, Uint8Array.of(ZSTD_FRAME_DESCRIPTOR), size];
    let offset = 0;
    do {
        const length = Math.min(ZSTD_MAX_BLOCK, data.length - offset);
        const last = offset + length >= data.length ? 1 : 0;
        // Block header, 3 bytes little-endian: last flag, block type 0 (raw), size.
        const value = last | (length << 3);
        chunks.push(Uint8Array.of(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff));
        chunks.push(data.subarray(offset, offset + length));
        offset += length;
    } while (offset < data.length);
    return concat(chunks);
}

export function concat(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}
