import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_FIRST_SEEN_ENTRIES } from '../../domain/ui/update-state-store';
import { createMemoryLogger } from '../../testing/memory-logger';
import { UI_DIR, UPDATE_STATE_FILE, UpdateStateStoreError, openFsUpdateStateStore } from './fs-update-state-store';

let dataDir: string;
beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ptbk-ui-state-'));
    await chmod(dataDir, 0o700);
});
afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
});

const KEY = 'a'.repeat(64);
const T0 = new Date('2026-10-21T12:00:00.000Z');
const file = () => join(dataDir, UI_DIR, UPDATE_STATE_FILE);
const open = (installed = false, logger = createMemoryLogger()) =>
    openFsUpdateStateStore({ dataDir, logger, installed });

describe('openFsUpdateStateStore', () => {
    it('stores the first-seen time once and keeps it across a restart', async () => {
        const store = await open();
        expect(await store.firstSeenAt(KEY, T0)).toEqual(T0);
        expect(await store.firstSeenAt(KEY, new Date(T0.getTime() + 1000))).toEqual(T0);
        expect((await stat(file())).mode & 0o777).toBe(0o600);
        const reopened = await open(true);
        expect(await reopened.firstSeenAt(KEY, new Date(T0.getTime() + 5000))).toEqual(T0);
    });

    it('keeps the newest accepted revocation issuedAt across a restart and never moves it back', async () => {
        const store = await open();
        expect(await store.lastAcceptedRevocationIssuedAt()).toBeNull();
        await store.acceptRevocations(T0);
        await store.acceptRevocations(new Date(T0.getTime() - 1));
        expect(await store.lastAcceptedRevocationIssuedAt()).toEqual(T0);
        expect(await (await open(true)).lastAcceptedRevocationIssuedAt()).toEqual(T0);
    });

    it('drops the oldest first-seen entries beyond the cap, which only restarts a delay', async () => {
        const store = await open();
        for (let index = 0; index <= MAX_FIRST_SEEN_ENTRIES; index++) {
            await store.firstSeenAt(index.toString(16).padStart(64, '0'), new Date(T0.getTime() + index));
        }
        const later = new Date(T0.getTime() + 10_000_000);
        expect(await store.firstSeenAt('0'.repeat(64), later)).toEqual(later);
        const stored = JSON.parse(await readFile(file(), 'utf8')) as { readonly firstSeen: unknown[] };
        expect(stored.firstSeen).toHaveLength(MAX_FIRST_SEEN_ENTRIES);
    });

    it('starts empty without an error on a first run', async () => {
        const logger = createMemoryLogger();
        await open(false, logger);
        expect(logger.entries).toEqual([]);
    });

    it.each([
        ['missing', () => Promise.resolve()],
        ['invalid', async () => writeFile(file(), '{"v":1,"firstSeen":[],"extra":1}', { mode: 0o600 })],
        ['unreadable', async () => writeFile(file(), '{', { mode: 0o600 })],
        ['not-private', async () => writeFile(file(), '{}', { mode: 0o644 })],
        ['too-large', async () => writeFile(file(), ' '.repeat(65 * 1024), { mode: 0o600 })],
    ])('starts empty and logs an error when the file is %s although a bundle is installed', async (reason, plant) => {
        await mkdir(join(dataDir, UI_DIR), { mode: 0o700 });
        await plant();
        const logger = createMemoryLogger();
        const store = await open(true, logger);
        expect(await store.lastAcceptedRevocationIssuedAt()).toBeNull();
        expect(logger.entries).toEqual([{ level: 'error', event: 'ui.update-state-lost', fields: { reason } }]);
    });

    it('refuses a UI directory others can read', async () => {
        await mkdir(join(dataDir, UI_DIR), { mode: 0o755 });
        await chmod(join(dataDir, UI_DIR), 0o755);
        await expect(open()).rejects.toThrow(UpdateStateStoreError);
    });
});
