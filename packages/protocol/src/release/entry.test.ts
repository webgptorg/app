import { describe, expect, it } from 'vitest';
import { concatBytes, utf8Encode } from '../bytes';
import { entryJson } from '../testing/release';
import { MAX_PROVENANCE_BYTES, ReleaseEntry, SignedRelease, parseReleaseEntry } from './entry';
import vectors from './vectors.json';

const regular: unknown = JSON.parse(vectors.regular.payloadText);
const security: unknown = JSON.parse(vectors.security.payloadText);
const envelope: unknown = JSON.parse(vectors.regular.envelope);

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

const artifact = (name: string, kind: 'engine' | 'ui' = 'engine') => ({
    name,
    sha256: vectors.artifact.sha256,
    kind,
});

describe('ReleaseEntry', () => {
    it.each([
        ['regular', regular],
        ['security', security],
        ['default test entry', entryJson()],
        [
            'engine and ui artifacts',
            entryJson({ artifacts: [artifact('engine-linux-x64.tar.zst'), artifact('ui', 'ui')] }),
        ],
        [
            '32 artifacts',
            entryJson({ artifacts: Array.from({ length: 32 }, (_, index) => artifact(`a${String(index)}`)) }),
        ],
        ['regular with an advisory', entryJson({ advisory: 'https://ptbk.io/notes/1' })],
        ['a slash in the tag', entryJson({ gitTag: 'release/ui-v2.0.0' })],
        ['a 128-character tag', entryJson({ gitTag: 'v'.repeat(128) })],
    ])('accepts %s', (_, value) => {
        expect(ReleaseEntry.safeParse(value).success).toBe(true);
    });

    it.each([
        ['an unknown field', { ...entryJson(), extra: true }],
        ['v 2', entryJson({ v: 2 })],
        ['a missing field', withoutKey(entryJson(), 'publishedAt')],
        ['security without advisory', entryJson({ kind: 'security', advisory: null })],
        ['an http advisory', entryJson({ kind: 'security', advisory: 'http://ptbk.io/security/1' })],
        ['a non-URL advisory', entryJson({ advisory: 'see the blog' })],
        ['two ui artifacts', entryJson({ artifacts: [artifact('a', 'ui'), artifact('b', 'ui')] })],
        ['duplicate artifact names', entryJson({ artifacts: [artifact('a'), artifact('a', 'ui')] })],
        ['no artifacts', entryJson({ artifacts: [] })],
        [
            '33 artifacts',
            entryJson({ artifacts: Array.from({ length: 33 }, (_, index) => artifact(`a${String(index)}`)) }),
        ],
        ['an unknown artifact kind', entryJson({ artifacts: [{ ...artifact('a'), kind: 'docs' }] })],
        ['an unknown artifact field', entryJson({ artifacts: [{ ...artifact('a'), size: 1 }] })],
        ['a 39-character commit', entryJson({ commit: '0123456789abcdef0123456789abcdef0123456' })],
        ['an uppercase commit', entryJson({ commit: '0123456789ABCDEF0123456789abcdef01234567' })],
        ['a short sha256', entryJson({ artifacts: [{ ...artifact('a'), sha256: 'ab'.repeat(31) }] })],
        ['an uppercase sha256', entryJson({ artifacts: [{ ...artifact('a'), sha256: 'AB'.repeat(32) }] })],
        ['an artifact name with /', entryJson({ artifacts: [artifact('ui/engine-ui.tar.zst')] })],
        ['an artifact name starting with .', entryJson({ artifacts: [artifact('.hidden')] })],
        ['an artifact name ..', entryJson({ artifacts: [artifact('..')] })],
        ['a tag with ..', entryJson({ gitTag: 'v1..2' })],
        ['a tag with //', entryJson({ gitTag: 'ui//v1' })],
        ['a tag with @', entryJson({ gitTag: 'v1@x' })],
        ['a tag with a space', entryJson({ gitTag: 'v1 x' })],
        ['a tag with a leading -', entryJson({ gitTag: '-v1' })],
        ['a tag with a trailing /', entryJson({ gitTag: 'v1/' })],
        ['an empty tag', entryJson({ gitTag: '' })],
        ['a 129-character tag', entryJson({ gitTag: 'v'.repeat(129) })],
        ['a non-SemVer version', entryJson({ version: '1.2' })],
        ['publishedAt with an offset', entryJson({ publishedAt: '2026-10-01T14:00:00+02:00' })],
        ['publishedAt without a zone', entryJson({ publishedAt: '2026-10-01T12:00:00' })],
    ])('rejects %s', (_, value) => {
        expect(ReleaseEntry.safeParse(value).success).toBe(false);
    });
});

describe('SignedRelease', () => {
    it('accepts an envelope with a provenance bundle', () => {
        expect(SignedRelease.safeParse({ v: 1, envelope, provenance: '{"mediaType":"x"}' }).success).toBe(true);
        expect(SignedRelease.safeParse({ v: 1, envelope, provenance: 'x'.repeat(MAX_PROVENANCE_BYTES) }).success).toBe(
            true,
        );
    });

    it.each([
        ['an empty provenance', { v: 1, envelope, provenance: '' }],
        [
            'a provenance over 64 KiB of characters',
            { v: 1, envelope, provenance: 'x'.repeat(MAX_PROVENANCE_BYTES + 1) },
        ],
        ['a provenance over 64 KiB of UTF-8', { v: 1, envelope, provenance: '€'.repeat(30_000) }],
        ['an unknown field', { v: 1, envelope, provenance: 'x', extra: 1 }],
        ['v 2', { v: 2, envelope, provenance: 'x' }],
        ['a missing envelope', { v: 1, provenance: 'x' }],
    ])('rejects %s', (_, value) => {
        expect(SignedRelease.safeParse(value).success).toBe(false);
    });
});

describe('parseReleaseEntry', () => {
    it('parses the exact payload bytes', () => {
        expect(parseReleaseEntry(utf8Encode(vectors.regular.payloadText))).toEqual(regular);
    });

    it.each([
        ['invalid UTF-8', concatBytes(utf8Encode('{"v":'), Uint8Array.of(0xff), utf8Encode('1}'))],
        ['a UTF-8 BOM', concatBytes(Uint8Array.of(0xef, 0xbb, 0xbf), utf8Encode(vectors.regular.payloadText))],
        ['not JSON', utf8Encode('{"v":1,')],
        ['empty bytes', new Uint8Array()],
        ['JSON that fails the schema', utf8Encode(JSON.stringify({ ...entryJson(), extra: 1 }))],
        ['JSON null', utf8Encode('null')],
    ])('rejects %s', (_, bytes) => {
        expect(parseReleaseEntry(bytes)).toBeUndefined();
    });
});
