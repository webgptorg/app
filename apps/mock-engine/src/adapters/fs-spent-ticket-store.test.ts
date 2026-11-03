import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MAX_SPENT_TICKETS } from '../domain/gateway/spent-tickets';
import { SPENT_TICKETS_FILE, SpentTicketStoreError, createFsSpentTicketStore } from './fs-spent-ticket-store';

const dirs: string[] = [];
afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function dataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'spent-tickets-'));
    await chmod(dir, 0o700);
    dirs.push(dir);
    return dir;
}

const NOW = Date.parse('2026-11-03T10:00:00Z');
const UNTIL = NOW + 17 * 60_000;
const id = (index: number) => `ticket-${String(index).padStart(12, '0')}`;

describe('createFsSpentTicketStore', () => {
    it('spends a ticket once, in a 0600 file a restart reads back', async () => {
        const dir = await dataDir();
        const store = createFsSpentTicketStore(dir);
        expect(await store.has(id(1), NOW)).toBe(false);
        expect(await store.spend(id(1), UNTIL, NOW)).toBe('ok');
        expect(await store.spend(id(1), UNTIL, NOW)).toBe('spent');
        expect(((await stat(join(dir, SPENT_TICKETS_FILE))).mode & 0o777).toString(8)).toBe('600');

        const restarted = createFsSpentTicketStore(dir);
        expect(await restarted.has(id(1), NOW + 60_000)).toBe(true);
        expect(await restarted.spend(id(1), UNTIL, NOW + 60_000)).toBe('spent');
    });

    it('forgets a ticket once it expired, and drops it from the file on the next write', async () => {
        const dir = await dataDir();
        const store = createFsSpentTicketStore(dir);
        await store.spend(id(1), UNTIL, NOW);
        expect(await store.has(id(1), UNTIL)).toBe(false);
        await store.spend(id(2), UNTIL + 60_000, UNTIL);
        expect(await readFile(join(dir, SPENT_TICKETS_FILE), 'utf8')).not.toContain(id(1));
    });

    it('lets one of two racing spends through', async () => {
        const store = createFsSpentTicketStore(await dataDir());
        const outcomes = await Promise.all([store.spend(id(1), UNTIL, NOW), store.spend(id(1), UNTIL, NOW)]);
        expect(outcomes.sort()).toEqual(['ok', 'spent']);
    });

    it(`refuses a new ticket while ${String(MAX_SPENT_TICKETS)} unexpired ones are kept`, async () => {
        const dir = await dataDir();
        const tickets = Array.from({ length: MAX_SPENT_TICKETS }, (_, index) => ({ id: id(index), until: UNTIL }));
        await writeFile(join(dir, SPENT_TICKETS_FILE), JSON.stringify({ v: 1, tickets }), { mode: 0o600 });
        const store = createFsSpentTicketStore(dir);
        expect(await store.spend(id(MAX_SPENT_TICKETS), UNTIL, NOW)).toBe('full');
        expect(await store.spend(id(MAX_SPENT_TICKETS), UNTIL + 60_000, UNTIL)).toBe('ok');
    });

    it('refuses a file others can read, and one that is not a spent-ticket list', async () => {
        const dir = await dataDir();
        const path = join(dir, SPENT_TICKETS_FILE);
        await createFsSpentTicketStore(dir).spend(id(1), UNTIL, NOW);
        await chmod(path, 0o640);
        await expect(createFsSpentTicketStore(dir).has(id(1), NOW)).rejects.toThrow(SpentTicketStoreError);
        for (const content of [
            'not json',
            JSON.stringify({ v: 1, tickets: [{ id: 'short', until: UNTIL }] }),
            JSON.stringify({ v: 1, tickets: [], extra: true }),
            'x'.repeat(129 * 1024),
        ]) {
            await writeFile(path, content);
            await chmod(path, 0o600);
            await expect(createFsSpentTicketStore(dir).spend(id(2), UNTIL, NOW)).rejects.toThrow(SpentTicketStoreError);
        }
    });
});
