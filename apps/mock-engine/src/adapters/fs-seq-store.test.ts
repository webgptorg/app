import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createFakeClock } from '../testing/fake-clock';
import { SEQ_FILE, SeqStoreError, createFsSeqStore } from './fs-seq-store';
import { createMemorySeqStore } from '../testing/memory-seq-store';

const NOW = Date.parse('2026-10-20T12:00:00Z');

const dirs: string[] = [];
afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function dataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'm06-seq-'));
    await chmod(dir, 0o700);
    dirs.push(dir);
    return dir;
}

async function persisted(dir: string): Promise<string> {
    return readFile(join(dir, SEQ_FILE), 'utf8');
}

async function writeSeqFile(dir: string, content: string, mode = 0o600): Promise<void> {
    const path = join(dir, SEQ_FILE);
    await writeFile(path, content, { mode });
    await chmod(path, mode);
}

describe('createFsSeqStore', () => {
    it('starts at the clock in milliseconds and persists each value before returning it', async () => {
        const dir = await dataDir();
        const clock = createFakeClock(NOW);
        const store = createFsSeqStore(dir, { clock });
        const first = await store.next();
        expect(first).toBe(NOW);
        expect(await persisted(dir)).toBe(`${String(NOW)}\n`);
        expect((await stat(join(dir, SEQ_FILE))).mode & 0o777).toBe(0o600);
        expect(await readdir(dir)).toEqual([SEQ_FILE]);
    });

    it('increases strictly whether the clock stands still, moves on or goes back', async () => {
        const dir = await dataDir();
        const clock = createFakeClock(NOW);
        const store = createFsSeqStore(dir, { clock });
        const values = [await store.next(), await store.next()];
        clock.advance(60_000);
        values.push(await store.next());
        const backwards = createFakeClock(NOW - 3_600_000);
        const restarted = createFsSeqStore(dir, { clock: backwards });
        values.push(await restarted.next());
        expect(values).toEqual([NOW, NOW + 1, NOW + 60_000, NOW + 60_001]);
        expect(await persisted(dir)).toBe(`${String(NOW + 60_001)}\n`);
    });

    it('never reuses a value persisted before a crash, even with an earlier clock', async () => {
        const dir = await dataDir();
        const clock = createFakeClock(NOW);
        const persistedBeforeCrash = await createFsSeqStore(dir, { clock }).next();
        // The process dies here, before sending; a new one starts on the same data directory.
        const sameClock = await createFsSeqStore(dir, { clock: createFakeClock(NOW) }).next();
        expect(sameClock).toBeGreaterThan(persistedBeforeCrash);
        const earlierClock = await createFsSeqStore(dir, { clock: createFakeClock(0) }).next();
        expect(earlierClock).toBeGreaterThan(sameClock);
    });

    it('jumps to the clock after a restart with a lost file, as C-03 recommends', async () => {
        const dir = await dataDir();
        await writeSeqFile(dir, '17\n');
        const clock = createFakeClock(NOW);
        expect(await createFsSeqStore(dir, { clock }).next()).toBe(NOW);
        const small = createFakeClock(5);
        expect(await createFsSeqStore(dir, { clock: small }).next()).toBe(NOW + 1);
    });

    it('accepts a file without a trailing newline', async () => {
        const dir = await dataDir();
        await writeSeqFile(dir, '41');
        expect(await createFsSeqStore(dir, { clock: createFakeClock(0) }).next()).toBe(42);
    });

    it('serialises concurrent calls into distinct increasing values', async () => {
        const dir = await dataDir();
        const store = createFsSeqStore(dir, { clock: createFakeClock(NOW) });
        const values = await Promise.all([store.next(), store.next(), store.next(), store.next()]);
        expect(values).toEqual([NOW, NOW + 1, NOW + 2, NOW + 3]);
        expect(await persisted(dir)).toBe(`${String(NOW + 3)}\n`);
    });

    it.each([
        ['text', 'not-a-number\n'],
        ['a negative number', '-5\n'],
        ['a leading zero', '0012\n'],
        ['an unsafe integer', '99999999999999999\n'],
        ['too much content', `${'1'.repeat(40)}\n`],
        ['an empty file', ''],
    ])('refuses a file with %s, without quoting it', async (_name, content) => {
        const dir = await dataDir();
        await writeSeqFile(dir, content);
        const store = createFsSeqStore(dir, { clock: createFakeClock(NOW) });
        const error = await store.next().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(SeqStoreError);
        expect((error as Error).message).toContain('does not hold a sequence number');
        if (content.trim() !== '') expect((error as Error).message).not.toContain(content.trim());
    });

    it('keeps working for the next call after a failed one', async () => {
        const dir = await dataDir();
        await writeSeqFile(dir, 'broken\n');
        const store = createFsSeqStore(dir, { clock: createFakeClock(NOW) });
        await expect(store.next()).rejects.toBeInstanceOf(SeqStoreError);
        await writeSeqFile(dir, '7\n');
        expect(await store.next()).toBe(NOW);
    });

    it('refuses a file group or others can read', async () => {
        const dir = await dataDir();
        await writeSeqFile(dir, '7\n', 0o644);
        await expect(createFsSeqStore(dir, { clock: createFakeClock(NOW) }).next()).rejects.toThrow('mode 0644');
    });

    it('checks the owner unless told not to', async () => {
        const dir = await dataDir();
        await writeSeqFile(dir, '7\n');
        const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
        await expect(createFsSeqStore(dir, { clock: createFakeClock(0), uid: uid + 1 }).next()).rejects.toThrow(
            'not owned',
        );
        expect(await createFsSeqStore(dir, { clock: createFakeClock(0), uid: null }).next()).toBe(8);
    });

    it('refuses to go past the largest safe integer', async () => {
        const dir = await dataDir();
        await writeSeqFile(dir, `${String(Number.MAX_SAFE_INTEGER)}\n`);
        await expect(createFsSeqStore(dir, { clock: createFakeClock(NOW) }).next()).rejects.toThrow('exhausted');
        expect(await persisted(dir)).toBe(`${String(Number.MAX_SAFE_INTEGER)}\n`);
    });
});

describe('createMemorySeqStore', () => {
    it('applies the same rule and exposes the last value', async () => {
        const clock = createFakeClock(NOW);
        const store = createMemorySeqStore(clock);
        expect(store.last()).toBeNull();
        expect([await store.next(), await store.next()]).toEqual([NOW, NOW + 1]);
        expect(store.last()).toBe(NOW + 1);
        expect(await createMemorySeqStore(createFakeClock(0), 10).next()).toBe(11);
    });
});
