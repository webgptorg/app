import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EngineId, Hostname } from '@ptbk/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { Registration } from '../domain/registration/registration';
import { REGISTRATION_FILE, RegistrationStoreError, createFsRegistrationStore } from './fs-registration-store';
import { createMemoryRegistrationStore } from '../testing/memory-registration-store';

const ENGINE_ID = EngineId.parse('abcdefghijklmnopqrstuvwxyz');
const REGISTRATION: Registration = {
    dashboardUrl: 'https://dashboard.ptbk.test',
    engineId: ENGINE_ID,
    hostname: Hostname.parse(`${ENGINE_ID}.engines.ptbk.test`),
    relays: [Hostname.parse('relay-a.ptbk.test'), Hostname.parse('relay-b.ptbk.test')],
};
const SECRET_MARKER = 'do-not-echo-this-content';

const dirs: string[] = [];
afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function dataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'm06-registration-'));
    await chmod(dir, 0o700);
    dirs.push(dir);
    return dir;
}

async function loadError(dir: string): Promise<RegistrationStoreError> {
    try {
        await createFsRegistrationStore(dir).load();
    } catch (error) {
        if (error instanceof RegistrationStoreError) return error;
        throw error;
    }
    throw new Error('expected a RegistrationStoreError');
}

async function writeStored(dir: string, content: string, mode = 0o600): Promise<void> {
    const path = join(dir, REGISTRATION_FILE);
    await writeFile(path, content, { mode });
    await chmod(path, mode);
}

const stored = (extra: Record<string, unknown> = {}): string => JSON.stringify({ v: 1, ...REGISTRATION, ...extra });

describe('createFsRegistrationStore', () => {
    it('loads null before the first registration', async () => {
        expect(await createFsRegistrationStore(await dataDir()).load()).toBeNull();
    });

    it('saves a registration that a new store loads again', async () => {
        const dir = await dataDir();
        await createFsRegistrationStore(dir).save(REGISTRATION);
        const loaded = await createFsRegistrationStore(dir).load();
        expect(loaded).toEqual(REGISTRATION);
        expect(Object.isFrozen(loaded)).toBe(true);
    });

    it('writes registration.json with mode 0600, only the known fields and no temporary file', async () => {
        const dir = await dataDir();
        await createFsRegistrationStore(dir).save(REGISTRATION);
        const path = join(dir, REGISTRATION_FILE);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(Object.keys(JSON.parse(await readFile(path, 'utf8')) as object)).toEqual([
            'v',
            'dashboardUrl',
            'engineId',
            'hostname',
            'relays',
        ]);
        expect(await readdir(dir)).toEqual([REGISTRATION_FILE]);
    });

    it('replaces an earlier registration', async () => {
        const dir = await dataDir();
        const store = createFsRegistrationStore(dir);
        await store.save(REGISTRATION);
        await store.save({ ...REGISTRATION, relays: [Hostname.parse('relay-c.ptbk.test')] });
        expect((await store.load())?.relays).toEqual(['relay-c.ptbk.test']);
    });

    it.each([
        ['an unknown field', stored({ linkCode: SECRET_MARKER })],
        ['invalid JSON', `{ "v": 1, ${SECRET_MARKER}`],
        ['no relays', stored({ relays: [] })],
        ['a duplicate relay', stored({ relays: ['relay-a.ptbk.test', 'relay-a.ptbk.test'] })],
        ['a plain http dashboard', stored({ dashboardUrl: 'http://dashboard.ptbk.test' })],
        ['another version', stored({ v: 2 })],
        ['a bad engine ID', stored({ engineId: SECRET_MARKER })],
    ])('refuses a file with %s, without quoting it', async (_name, content) => {
        const dir = await dataDir();
        await writeStored(dir, content);
        const error = await loadError(dir);
        expect(error.message).toContain('is not a valid registration');
        expect(error.message).not.toContain(SECRET_MARKER);
    });

    it('refuses a file over the size cap', async () => {
        const dir = await dataDir();
        await writeStored(dir, stored({ padding: 'x'.repeat(20_000) }));
        expect((await loadError(dir)).message).toContain('too large');
    });

    it('refuses a file group or others can read', async () => {
        const dir = await dataDir();
        await writeStored(dir, stored(), 0o644);
        expect((await loadError(dir)).message).toContain('mode 0644');
    });

    it('refuses a symbolic link', async () => {
        const dir = await dataDir();
        const target = join(dir, 'elsewhere.json');
        await writeFile(target, stored(), { mode: 0o600 });
        await symlink(target, join(dir, REGISTRATION_FILE));
        expect((await loadError(dir)).message).toContain('symbolic links are refused');
    });

    it('checks the owner unless told not to', async () => {
        const dir = await dataDir();
        await writeStored(dir, stored());
        const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
        await expect(createFsRegistrationStore(dir, { uid: uid + 1 }).load()).rejects.toThrow('not owned');
        expect(await createFsRegistrationStore(dir, { uid: null }).load()).toEqual(REGISTRATION);
    });
});

describe('createMemoryRegistrationStore', () => {
    it('keeps the saved registration until cleared', async () => {
        const store = createMemoryRegistrationStore();
        expect(await store.load()).toBeNull();
        await store.save(REGISTRATION);
        expect(await store.load()).toBe(REGISTRATION);
        store.clear();
        expect(await store.load()).toBeNull();
        expect(await createMemoryRegistrationStore(REGISTRATION).load()).toBe(REGISTRATION);
    });
});
