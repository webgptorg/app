import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findCachedTrustedRoot } from './trusted-root.ts';

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
