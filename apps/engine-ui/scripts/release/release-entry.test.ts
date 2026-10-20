import { parseReleaseEntry } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { buildReleasePayload } from './release-entry.ts';

const input = {
    version: '0.0.0-dryrun.1',
    gitTag: 'ui-v0.0.0-dryrun.1',
    commit: 'a'.repeat(40),
    archiveSha256: 'b'.repeat(64),
    publishedAt: new Date('2026-10-20T12:00:00.000Z'),
};

describe('buildReleasePayload', () => {
    it('is a regular release entry with the one ui artifact, parsed back by C-06', () => {
        const entry = parseReleaseEntry(buildReleasePayload(input));
        expect(entry).toEqual({
            v: 1,
            version: '0.0.0-dryrun.1',
            gitTag: 'ui-v0.0.0-dryrun.1',
            commit: 'a'.repeat(40),
            artifacts: [{ name: 'engine-ui.tar.zst', sha256: 'b'.repeat(64), kind: 'ui' }],
            kind: 'regular',
            advisory: null,
            publishedAt: '2026-10-20T12:00:00.000Z',
        });
    });

    it('refuses values the schema refuses', () => {
        expect(() => buildReleasePayload({ ...input, commit: 'abc' })).toThrow();
        expect(() => buildReleasePayload({ ...input, gitTag: 'ui-v..1' })).toThrow();
    });
});
