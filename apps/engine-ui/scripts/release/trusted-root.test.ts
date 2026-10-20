import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkTrustedRoot, findCachedTrustedRoot } from './trusted-root.ts';

const pinnedPath = join(import.meta.dirname, '..', '..', 'release', 'trusted_root.json');

async function pinned(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(pinnedPath, 'utf8')) as Record<string, unknown>;
}

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

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

describe('findCachedTrustedRoot', () => {
    const dirs: string[] = [];
    afterEach(async () => {
        await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    async function cache(...repos: string[]): Promise<string> {
        const dir = await mkdtemp(join(tmpdir(), 'ptbk-tuf-test-'));
        dirs.push(dir);
        await Promise.all(repos.map((repo) => mkdir(join(dir, repo, 'targets'), { recursive: true })));
        return dir;
    }

    it('finds the target under the one mirror directory', async () => {
        const dir = await cache('tuf-repo-cdn.sigstore.dev');
        expect(await findCachedTrustedRoot(dir)).toBe(
            join(dir, 'tuf-repo-cdn.sigstore.dev', 'targets', 'trusted_root.json'),
        );
    });

    it('refuses an empty or ambiguous cache', async () => {
        await expect(findCachedTrustedRoot(await cache())).rejects.toThrow('found 0');
        await expect(findCachedTrustedRoot(await cache('a', 'b'))).rejects.toThrow('found 2');
    });
});
