import { zstdDecompressSync } from 'node:zlib';

import { TAR_LIMITS, TarFormatError, readTar } from './tar';

/** The manifest's path inside the UI archive, always its first entry, and its file name next to the archive. */
export const UI_ARCHIVE_MANIFEST_PATH = 'manifest.json';

/** Decompresses a `tar.zst`; output beyond the largest accepted tar (a zstd bomb) throws instead of allocating. */
export function decompressArchive(archive: Uint8Array): Uint8Array {
    return zstdDecompressSync(archive, { maxOutputLength: TAR_LIMITS.maxUnpackedBytes + 16 * 1024 * 1024 });
}

export interface UiArchive {
    /** The manifest's exact bytes, unparsed: the caller parses them with C-06's `UiBundleManifest`. */
    readonly manifestBytes: Uint8Array<ArrayBuffer>;
    /** Every other file, by path. */
    readonly files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
}

/**
 * Reads a UI archive (`tar.zst`, manifest first) within `TAR_LIMITS`. Throws `TarFormatError` or `TarPathError` for
 * anything `readTar` refuses (links, devices, unsafe or duplicate paths, extended headers) and for a missing manifest.
 */
export function readUiArchive(archive: Uint8Array): UiArchive {
    let tar: Uint8Array;
    try {
        tar = decompressArchive(archive);
    } catch {
        throw new TarFormatError('not a zstd archive within the size limit');
    }
    const [first, ...rest] = readTar(tar);
    if (first?.path !== UI_ARCHIVE_MANIFEST_PATH) {
        throw new TarFormatError(`the first entry is not ${UI_ARCHIVE_MANIFEST_PATH}`);
    }
    return { manifestBytes: first.bytes, files: new Map(rest.map((file) => [file.path, file.bytes])) };
}
