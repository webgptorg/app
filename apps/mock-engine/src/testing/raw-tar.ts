import { constants, zstdCompressSync } from 'node:zlib';

/** One ustar entry as an attacker would write it: any name, type and size, nothing checked. */
export interface RawTarEntry {
    readonly name: string;
    /** `0` file, `1` hard link, `2` symlink, `3`/`4` devices, `5` directory. */
    readonly type?: string;
    readonly bytes?: Uint8Array;
    readonly linkName?: string;
    /** The size the header claims, if not the length of `bytes`. */
    readonly size?: number;
}

const BLOCK = 512;
const ascii = new TextEncoder();

function header(entry: RawTarEntry, size: number): Uint8Array {
    const block = new Uint8Array(BLOCK);
    const put = (offset: number, value: string): void => {
        block.set(ascii.encode(value), offset);
    };
    put(0, entry.name.slice(0, 100));
    put(100, '0000644\0');
    put(108, '0000000\0');
    put(116, '0000000\0');
    put(124, `${size.toString(8).padStart(11, '0')}\0`);
    put(136, '00000000000\0');
    put(148, '        ');
    put(156, entry.type ?? '0');
    put(157, (entry.linkName ?? '').slice(0, 100));
    put(257, 'ustar\0');
    put(263, '00');
    const checksum = block.reduce((sum, byte) => sum + byte, 0);
    put(148, `${checksum.toString(8).padStart(6, '0')}\0 `);
    return block;
}

/** A `tar.zst` of the entries exactly as given, for tests of what the unpacker must refuse. */
export function rawTarZst(entries: readonly RawTarEntry[]): Uint8Array<ArrayBuffer> {
    const chunks: Uint8Array[] = [];
    for (const entry of entries) {
        const bytes = entry.bytes ?? new Uint8Array();
        chunks.push(header(entry, entry.size ?? bytes.length), bytes);
        const padding = (BLOCK - (bytes.length % BLOCK)) % BLOCK;
        if (padding > 0) chunks.push(new Uint8Array(padding));
    }
    chunks.push(new Uint8Array(2 * BLOCK));
    const tar = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        tar.set(chunk, offset);
        offset += chunk.length;
    }
    return new Uint8Array(zstdCompressSync(tar, { params: { [constants.ZSTD_c_compressionLevel]: 3 } }));
}
