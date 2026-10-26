import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SETUP_SECRET_FILE, SetupSecretStoreError, createFsSetupSecretStore } from './fs-setup-secret-store';

const dirs: string[] = [];
afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function dataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'm08-secret-'));
    await chmod(dir, 0o700);
    dirs.push(dir);
    return dir;
}

const STORED = { sha256: 'a'.repeat(64), expiresAtMs: Date.parse('2026-10-26T10:30:00Z') };

describe('createFsSetupSecretStore', () => {
    it('keeps the digest and expiry in a 0600 file across instances, and clears it', async () => {
        const dir = await dataDir();
        const store = createFsSetupSecretStore(dir);
        expect(await store.load()).toBeNull();
        await store.save(STORED);
        const path = join(dir, SETUP_SECRET_FILE);
        expect(((await stat(path)).mode & 0o777).toString(8)).toBe('600');
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
            v: 1,
            sha256: STORED.sha256,
            expiresAt: '2026-10-26T10:30:00.000Z',
        });
        expect(await createFsSetupSecretStore(dir).load()).toEqual(STORED);
        await store.clear();
        expect(await store.load()).toBeNull();
        await store.clear();
    });

    it('refuses a file others can read, one that is too large, and one that is not a stored secret', async () => {
        const dir = await dataDir();
        const path = join(dir, SETUP_SECRET_FILE);
        await createFsSetupSecretStore(dir).save(STORED);
        await chmod(path, 0o644);
        await expect(createFsSetupSecretStore(dir).load()).rejects.toThrow(SetupSecretStoreError);
        for (const content of ['x'.repeat(2048), '{"v":1,"sha256":"zz","expiresAt":"x"}', 'not json']) {
            await writeFile(path, content, { mode: 0o600 });
            await chmod(path, 0o600);
            await expect(createFsSetupSecretStore(dir).load()).rejects.toThrow(SetupSecretStoreError);
        }
    });
});
