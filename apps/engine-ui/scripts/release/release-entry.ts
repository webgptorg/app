import { ReleaseEntry } from '@ptbk/protocol';

import { ARCHIVE_NAME } from './archive.ts';

export interface ReleasePayloadInput {
    readonly version: string;
    readonly gitTag: string;
    readonly commit: string;
    readonly archiveSha256: string;
    readonly publishedAt: Date;
}

/**
 * C-06's `ReleaseEntry` for a UI release, as the exact bytes every signature covers. The caller writes them once;
 * nothing after that re-serialises the entry. UI releases get their own entry until the engine release tooling can
 * carry the UI artifact (E-01).
 */
export function buildReleasePayload(input: ReleasePayloadInput): Uint8Array<ArrayBuffer> {
    const entry = ReleaseEntry.parse({
        v: 1,
        version: input.version,
        gitTag: input.gitTag,
        commit: input.commit,
        artifacts: [{ name: ARCHIVE_NAME, sha256: input.archiveSha256, kind: 'ui' }],
        kind: 'regular',
        advisory: null,
        publishedAt: input.publishedAt.toISOString(),
    });
    return new TextEncoder().encode(JSON.stringify(entry));
}
