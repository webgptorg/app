import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { StoredPasskey } from '../domain/gateway/passkey-gateway';
import { PASSKEYS_FILE, PasskeyStoreError, createFsPasskeyStore } from './fs-passkey-store';

const dirs: string[] = [];
afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function dataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'm08-passkeys-'));
    await chmod(dir, 0o700);
    dirs.push(dir);
    return dir;
}

const PASSKEY: StoredPasskey = {
    credentialId: 'Y3JlZGVudGlhbA',
    publicKey: 'cHVibGljLWtleQ',
    counter: 0,
    transports: ['internal'],
    attachment: 'platform',
    backedUp: true,
    passkeyId: 'passkey-abc',
    memberId: 'member-owner',
    name: 'Built-in passkey',
    createdAt: '2026-10-26T10:00:00Z',
    member: { displayName: 'Owner', role: 'owner', createdAt: '2026-10-01T00:00:00Z' },
};

describe('createFsPasskeyStore', () => {
    it('keeps public keys and counters in a 0600 file that a restart reads back, and clears them', async () => {
        const dir = await dataDir();
        const store = createFsPasskeyStore(dir);
        expect(await store.list()).toEqual([]);
        await store.add(PASSKEY);
        expect(((await stat(join(dir, PASSKEYS_FILE))).mode & 0o777).toString(8)).toBe('600');
        await store.update(PASSKEY.credentialId, { counter: 4, backedUp: false });
        expect(await createFsPasskeyStore(dir).list()).toEqual([{ ...PASSKEY, counter: 4, backedUp: false }]);
        await expect(store.add(PASSKEY)).rejects.toThrow(PasskeyStoreError);
        await store.clear();
        expect(await store.list()).toEqual([]);
    });

    it('refuses a file others can read, and one that is not a passkey list', async () => {
        const dir = await dataDir();
        const path = join(dir, PASSKEYS_FILE);
        await createFsPasskeyStore(dir).add(PASSKEY);
        await chmod(path, 0o640);
        await expect(createFsPasskeyStore(dir).list()).rejects.toThrow(PasskeyStoreError);
        for (const content of ['not json', JSON.stringify({ v: 1, passkeys: [{ ...PASSKEY, extra: true }] })]) {
            await writeFile(path, content);
            await chmod(path, 0o600);
            await expect(createFsPasskeyStore(dir).list()).rejects.toThrow(PasskeyStoreError);
        }
    });
});
