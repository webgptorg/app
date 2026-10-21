import { createHash } from 'node:crypto';

import type { TarFile } from '@ptbk/release-tools';
import { compareBytes, decompressArchive, readTar } from '@ptbk/release-tools';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The first path, in byte order, that only one side has or whose bytes differ. */
export function firstDifference(a: readonly TarFile[], b: readonly TarFile[]): string | undefined {
    const left = new Map(a.map((file) => [file.path, sha256(file.bytes)]));
    const right = new Map(b.map((file) => [file.path, sha256(file.bytes)]));
    const paths = [...new Set([...left.keys(), ...right.keys()])].sort(compareBytes);
    return paths.find((path) => left.get(path) !== right.get(path));
}

function entries(archive: Uint8Array): TarFile[] | undefined {
    try {
        return readTar(decompressArchive(archive));
    } catch {
        return undefined;
    }
}

export type ReproducibilityCheck =
    { readonly kind: 'identical'; readonly sha256: string } | { readonly kind: 'different'; readonly detail: string };

/** Compares two release archives and, when they differ, names the first differing file. */
export function compareArchives(a: Uint8Array, b: Uint8Array): ReproducibilityCheck {
    const [hashA, hashB] = [sha256(a), sha256(b)];
    if (hashA === hashB) return { kind: 'identical', sha256: hashA };
    const [filesA, filesB] = [entries(a), entries(b)];
    if (filesA === undefined || filesB === undefined) {
        return { kind: 'different', detail: `${hashA} vs ${hashB}; an archive does not unpack` };
    }
    const path = firstDifference(filesA, filesB);
    return {
        kind: 'different',
        detail:
            path === undefined
                ? `${hashA} vs ${hashB}; same files, different archive framing (tar headers or zstd)`
                : `${hashA} vs ${hashB}; first differing file: ${path}`,
    };
}
