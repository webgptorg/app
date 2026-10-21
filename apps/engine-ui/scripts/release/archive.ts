import { constants, zstdCompressSync } from 'node:zlib';

import { UiBundleManifest } from '@ptbk/protocol';
import { TarFormatError, readUiArchive, writeTar } from '@ptbk/release-tools';

import { MANIFEST_PATH, buildManifest, encodeManifest } from './manifest.ts';
import type { ManifestInput } from './manifest.ts';

export const ARCHIVE_NAME = 'engine-ui.tar.zst';
/** Fixed, so the same tar always compresses to the same bytes with the same zstd (pinned through `.nvmrc`). */
export const ZSTD_LEVEL = 19;

export function compressArchive(tar: Uint8Array): Uint8Array<ArrayBuffer> {
    return zstdCompressSync(tar, {
        params: {
            [constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL,
            [constants.ZSTD_c_checksumFlag]: 1,
        },
    });
}

export interface PackedBundle {
    readonly manifest: UiBundleManifest;
    readonly manifestBytes: Uint8Array<ArrayBuffer>;
    readonly archive: Uint8Array<ArrayBuffer>;
}

/** The release archive of `dist/`: the manifest first, then every file; `mtime` is `SOURCE_DATE_EPOCH`. */
export function packBundle(input: ManifestInput & { readonly mtime: number }): PackedBundle {
    const manifest = buildManifest(input);
    const manifestBytes = encodeManifest(manifest);
    const tar = writeTar([{ path: MANIFEST_PATH, bytes: manifestBytes }, ...input.files], {
        mtime: input.mtime,
        first: MANIFEST_PATH,
    });
    return { manifest, manifestBytes, archive: compressArchive(tar) };
}

export interface UnpackedBundle {
    readonly manifest: UiBundleManifest;
    readonly manifestBytes: Uint8Array<ArrayBuffer>;
    /** Every file except the manifest. */
    readonly files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
}

/** Unpacks an archive `packBundle` wrote; throws `TarFormatError` on anything else. */
export function unpackBundle(archive: Uint8Array): UnpackedBundle {
    const { manifestBytes, files } = readUiArchive(archive);
    const manifest = parseManifest(manifestBytes);
    if (manifest === undefined) throw new TarFormatError('the manifest does not match UiBundleManifest');
    return { manifest, manifestBytes, files };
}

export function parseManifest(bytes: Uint8Array): UiBundleManifest | undefined {
    let json: unknown;
    try {
        json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
        return undefined;
    }
    const parsed = UiBundleManifest.safeParse(json);
    return parsed.success ? parsed.data : undefined;
}
