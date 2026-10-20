import { describe, expect, it } from 'vitest';
import { concatBytes, utf8Encode } from '../bytes';
import { EngineVersion } from '../ids';
import { RevocationList, findRevocation, parseRevocationList } from './revocation';
import vectors from './vectors.json';

const list = (fields: Record<string, unknown> = {}) => ({
    v: 1,
    issuedAt: '2026-10-02T00:00:00Z',
    expiresAt: '2026-10-09T00:00:00Z',
    revoked: [{ version: '1.8.1', reason: 'not reproducible' }],
    ...fields,
});

describe('RevocationList', () => {
    it.each([
        ['the vector list', JSON.parse(vectors.revocations.payloadText) as unknown],
        ['an empty list', list({ revoked: [] })],
        [
            '1,000 entries',
            list({
                revoked: Array.from({ length: 1000 }, (_, index) => ({ version: `1.0.${String(index)}`, reason: '' })),
            }),
        ],
        ['a 500-character reason', list({ revoked: [{ version: '1.0.0', reason: 'r'.repeat(500) }] })],
        ['one millisecond of validity', list({ expiresAt: '2026-10-02T00:00:00.001Z' })],
    ])('accepts %s', (_, value) => {
        expect(RevocationList.safeParse(value).success).toBe(true);
    });

    it.each([
        ['expiresAt equal to issuedAt', list({ expiresAt: '2026-10-02T00:00:00Z' })],
        ['expiresAt before issuedAt', list({ expiresAt: '2026-10-01T00:00:00Z' })],
        [
            'a duplicate version',
            list({
                revoked: [
                    { version: '1.8.1', reason: 'a' },
                    { version: '1.8.1', reason: 'b' },
                ],
            }),
        ],
        [
            'versions of the same precedence',
            list({
                revoked: [
                    { version: '1.8.1', reason: 'a' },
                    { version: '1.8.1+build', reason: 'b' },
                ],
            }),
        ],
        [
            '1,001 entries',
            list({
                revoked: Array.from({ length: 1001 }, (_, index) => ({ version: `1.0.${String(index)}`, reason: '' })),
            }),
        ],
        ['a 501-character reason', list({ revoked: [{ version: '1.0.0', reason: 'r'.repeat(501) }] })],
        ['an unknown field', { ...list(), signer: 'x' }],
        ['an unknown entry field', list({ revoked: [{ version: '1.0.0', reason: '', by: 'x' }] })],
        ['a bad version', list({ revoked: [{ version: 'v1.0.0', reason: '' }] })],
        ['v 2', list({ v: 2 })],
        ['a non-UTC issuedAt', list({ issuedAt: '2026-10-02T02:00:00+02:00' })],
    ])('rejects %s', (_, value) => {
        expect(RevocationList.safeParse(value).success).toBe(false);
    });
});

describe('parseRevocationList', () => {
    it('parses the exact payload bytes', () => {
        expect(parseRevocationList(utf8Encode(vectors.revocations.payloadText))).toEqual(
            JSON.parse(vectors.revocations.payloadText),
        );
    });

    it.each([
        ['invalid UTF-8', concatBytes(utf8Encode('{"v":1'), Uint8Array.of(0xc3), utf8Encode('}'))],
        ['a UTF-8 BOM', concatBytes(Uint8Array.of(0xef, 0xbb, 0xbf), utf8Encode(vectors.revocations.payloadText))],
        ['not JSON', utf8Encode('revoked: 1.8.1')],
        ['JSON that fails the schema', utf8Encode(JSON.stringify(list({ v: 2 })))],
    ])('rejects %s', (_, bytes) => {
        expect(parseRevocationList(bytes)).toBeUndefined();
    });
});

describe('findRevocation', () => {
    const parsed = RevocationList.parse(list({ revoked: [{ version: '1.8.1+build.7', reason: 'bad' }] }));

    it('matches by SemVer precedence, ignoring build metadata', () => {
        expect(findRevocation(parsed, EngineVersion.parse('1.8.1'))?.reason).toBe('bad');
        expect(findRevocation(parsed, EngineVersion.parse('1.8.1+other'))?.reason).toBe('bad');
    });

    it('does not match other versions', () => {
        expect(findRevocation(parsed, EngineVersion.parse('1.8.10'))).toBeUndefined();
        expect(findRevocation(parsed, EngineVersion.parse('1.8.1-rc.1'))).toBeUndefined();
    });
});
