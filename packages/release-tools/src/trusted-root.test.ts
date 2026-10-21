import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { PINNED_TRUSTED_ROOT, PINNED_TRUSTED_ROOT_FILE, checkTrustedRoot } from './trusted-root';

const pinnedPath = PINNED_TRUSTED_ROOT_FILE;

async function pinned(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(pinnedPath, 'utf8')) as Record<string, unknown>;
}

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

describe('PINNED_TRUSTED_ROOT', () => {
    it('is the committed file, parsed', async () => {
        expect(PINNED_TRUSTED_ROOT).toEqual(await pinned());
    });
});

describe('checkTrustedRoot', () => {
    it('accepts the pinned root, with a Fulcio CA, Rekor, CT log and TSA', async () => {
        const result = checkTrustedRoot(await readFile(pinnedPath));
        expect(result.kind).toBe('ok');
    });

    it.each(['certificateAuthorities', 'tlogs', 'ctlogs', 'timestampAuthorities'])(
        'refuses a root without %s',
        async (part) => {
            const root = { ...(await pinned()), [part]: [] };
            expect(checkTrustedRoot(bytes(root))).toEqual({ kind: 'invalid', reason: `no ${part}` });
        },
    );

    it('refuses another media type', async () => {
        const root = { ...(await pinned()), mediaType: 'application/json' };
        expect(checkTrustedRoot(bytes(root))).toEqual({ kind: 'invalid', reason: 'unexpected media type' });
    });

    it('refuses a root whose keys do not load', async () => {
        const root = await pinned();
        const tlogs = (root['tlogs'] as { publicKey: Record<string, unknown> }[]).map((tlog) => ({
            ...tlog,
            publicKey: { ...tlog.publicKey, rawBytes: 'AAAA' },
        }));
        expect(checkTrustedRoot(bytes({ ...root, tlogs }))).toEqual({ kind: 'invalid', reason: 'keys do not load' });
    });

    it.each([
        ['invalid UTF-8', Uint8Array.of(0xff)],
        ['not JSON', new TextEncoder().encode('{')],
        ['a JSON array', bytes([])],
        ['JSON null', bytes(null)],
    ])('refuses %s', (_, input) => {
        expect(checkTrustedRoot(input).kind).toBe('invalid');
    });
});
