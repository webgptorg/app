import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EngineVersion } from '@ptbk/protocol';
import { TAR_LIMITS } from '@ptbk/release-tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BundleStore, StageOutcome } from '../../domain/ui/bundle-store';
import { createMemoryLogger } from '../../testing/memory-logger';
import type { RawTarEntry } from '../../testing/raw-tar';
import { rawTarZst } from '../../testing/raw-tar';
import { TEST_BUNDLE_FILES, buildTestBundle } from '../../testing/ui-releases';
import { removeTree, unpackBundle } from './bundle-unpacker';
import { ACTIVE_FILE, BundleStoreError, openFsBundleStore } from './fs-bundle-store';
import { UI_DIR } from './fs-update-state-store';

let dataDir: string;
beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ptbk-ui-store-'));
    await chmod(dataDir, 0o700);
});
afterEach(async () => {
    await removeTree(dataDir);
});

const uiDir = () => join(dataDir, UI_DIR);
const text = (value: string) => new TextEncoder().encode(value);
const manifestEntry: RawTarEntry = { name: 'manifest.json', bytes: text('{}') };

async function entries(): Promise<string[]> {
    return (await readdir(uiDir())).sort();
}

function staged(outcome: StageOutcome) {
    if (outcome.kind !== 'staged') throw new Error(`not staged: ${outcome.reason}`);
    return outcome.bundle;
}

async function install(store: BundleStore, version: string, files = TEST_BUNDLE_FILES) {
    const bundle = buildTestBundle({ version, files });
    const { stagingId } = staged(await store.stage(bundle.archive, new AbortController().signal));
    return store.activate(stagingId, {
        version: EngineVersion.parse(version),
        sha256: bundle.sha256,
        logIndex: 7,
        manifest: bundle.manifest,
    });
}

describe('unpackBundle', () => {
    let dir: string;
    beforeEach(async () => {
        dir = join(dataDir, 'target');
        await mkdir(dir);
    });

    it('writes every file and returns them as read back from disk, with the manifest apart', async () => {
        const bundle = buildTestBundle({ version: '1.0.0' });
        const outcome = await unpackBundle(bundle.archive, dir);
        if (outcome.kind !== 'unpacked') throw new Error(outcome.reason);
        expect([...outcome.files.keys()].sort()).toEqual(TEST_BUNDLE_FILES.map((file) => file.path).sort());
        expect(JSON.parse(new TextDecoder().decode(outcome.manifestBytes))).toEqual(bundle.manifest);
        expect(await readdir(join(dir, 'assets'))).toContain('index-BxD3f9_a.js');
    });

    it.each<[string, RawTarEntry[], RegExp]>([
        ['path traversal', [manifestEntry, { name: '../escape.js', bytes: text('x') }], /\.\./],
        ['traversal inside a path', [manifestEntry, { name: 'assets/../../escape.js', bytes: text('x') }], /\.\./],
        ['an absolute path', [manifestEntry, { name: '/etc/passwd', bytes: text('x') }], /not a relative path/],
        [
            'a symlink',
            [manifestEntry, { name: 'index.html', type: '2', linkName: '/etc/passwd' }],
            /not a regular file/,
        ],
        [
            'a hard link',
            [manifestEntry, { name: 'index.html', type: '1', linkName: 'manifest.json' }],
            /not a regular file/,
        ],
        ['a character device', [manifestEntry, { name: 'tty', type: '3' }], /not a regular file/],
        ['a block device', [manifestEntry, { name: 'disk', type: '4' }], /not a regular file/],
        [
            'a duplicate path',
            [manifestEntry, { name: 'a.js', bytes: text('1') }, { name: 'a.js', bytes: text('2') }],
            /duplicate/,
        ],
        ['a manifest that is not first', [{ name: 'index.html', bytes: text('x') }, manifestEntry], /first entry/],
        [
            'more than 200 MB unpacked',
            [manifestEntry, { name: 'big.bin', size: TAR_LIMITS.maxUnpackedBytes + 1 }],
            /too large/,
        ],
    ])('refuses %s and writes nothing', async (_, archive, reason) => {
        const outcome = await unpackBundle(rawTarZst(archive), dir);
        expect(outcome).toEqual({ kind: 'refused', reason: expect.stringMatching(reason) as unknown });
        expect(await readdir(dir)).toEqual([]);
        expect(await readdir(dataDir)).not.toContain('escape.js');
    });

    it('refuses more than 10,000 files', async () => {
        const many = Array.from({ length: TAR_LIMITS.maxEntries }, (_, index) => ({ name: `f${String(index)}` }));
        const outcome = await unpackBundle(rawTarZst([manifestEntry, ...many]), dir);
        expect(outcome).toEqual({ kind: 'refused', reason: 'too many entries' });
    });

    it('never writes through an existing name', async () => {
        await writeFile(join(dir, 'index.html'), 'planted');
        await expect(unpackBundle(buildTestBundle({ version: '1.0.0' }).archive, dir)).rejects.toThrow(/EEXIST/);
    });
});

describe('openFsBundleStore', () => {
    it('stages, activates read-only, keeps the previous bundle and deletes older ones', async () => {
        const store = await openFsBundleStore({ dataDir, logger: createMemoryLogger() });
        expect(store.active()).toBeUndefined();
        const first = await install(store, '1.0.0');
        expect(first.id).toBe(`1.0.0-${first.sha256.slice(0, 16)}`);
        expect(store.active()).toEqual(first);
        expect((await stat(join(uiDir(), first.id))).mode & 0o777).toBe(0o555);
        expect((await stat(join(uiDir(), first.id, 'index.html'))).mode & 0o777).toBe(0o444);
        expect((await stat(join(uiDir(), ACTIVE_FILE))).mode & 0o777).toBe(0o600);

        const second = await install(store, '1.1.0', [...TEST_BUNDLE_FILES, { path: 'new.txt', bytes: text('2') }]);
        const third = await install(store, '1.2.0', [...TEST_BUNDLE_FILES, { path: 'new.txt', bytes: text('3') }]);
        expect(store.active()).toEqual(third);
        expect(store.previous()).toEqual(second);
        expect(await entries()).toEqual([ACTIVE_FILE, second.id, third.id].sort());
    });

    it('reads only files the bundle’s manifest lists', async () => {
        const store = await openFsBundleStore({ dataDir, logger: createMemoryLogger() });
        const bundle = await install(store, '1.0.0');
        expect(new TextDecoder().decode(await store.read(bundle, 'assets/index-BxD3f9_a.js'))).toContain('document');
        expect(await store.read(bundle, 'manifest.json')).toBeUndefined();
        expect(await store.read(bundle, '../active.json')).toBeUndefined();
        expect(await store.read({ ...bundle, id: 'gone' }, 'index.html')).toBeUndefined();
    });

    it('removes the staging directory of an archive it refuses, and of a discarded bundle', async () => {
        const store = await openFsBundleStore({ dataDir, logger: createMemoryLogger() });
        const refused = await store.stage(
            rawTarZst([manifestEntry, { name: '../x', bytes: text('x') }]),
            new AbortController().signal,
        );
        expect(refused.kind).toBe('unpack-failed');
        expect(await entries()).toEqual([]);
        const { stagingId } = staged(
            await store.stage(buildTestBundle({ version: '1.0.0' }).archive, new AbortController().signal),
        );
        expect(await entries()).toEqual([stagingId]);
        await store.discard(stagingId);
        expect(await entries()).toEqual([]);
        await expect(
            store.activate('not-staging', {
                version: EngineVersion.parse('1.0.0'),
                sha256: 'a'.repeat(64),
                logIndex: 1,
                manifest: buildTestBundle({ version: '1.0.0' }).manifest,
            }),
        ).rejects.toThrow(BundleStoreError);
    });

    it('reopens with the same active and previous bundle, and cleans up leftovers', async () => {
        const store = await openFsBundleStore({ dataDir, logger: createMemoryLogger() });
        const first = await install(store, '1.0.0');
        const second = await install(store, '1.1.0', [...TEST_BUNDLE_FILES, { path: 'x.txt', bytes: text('x') }]);
        await mkdir(join(uiDir(), 'staging-left-over'));
        const reopened = await openFsBundleStore({ dataDir, logger: createMemoryLogger() });
        expect(reopened.active()).toEqual(second);
        expect(reopened.previous()).toEqual(first);
        expect(await entries()).toEqual([ACTIVE_FILE, first.id, second.id].sort());
    });

    it('never serves a bundle changed on disk: the previous one takes over', async () => {
        const store = await openFsBundleStore({ dataDir, logger: createMemoryLogger() });
        const first = await install(store, '1.0.0');
        const second = await install(store, '1.1.0', [...TEST_BUNDLE_FILES, { path: 'x.txt', bytes: text('x') }]);
        const target = join(uiDir(), second.id, 'x.txt');
        await chmod(join(uiDir(), second.id), 0o700);
        await chmod(target, 0o600);
        await writeFile(target, 'y');
        const logger = createMemoryLogger();
        const reopened = await openFsBundleStore({ dataDir, logger });
        expect(reopened.active()).toEqual(first);
        expect(reopened.previous()).toBeUndefined();
        expect(logger.entries).toContainEqual({
            level: 'error',
            event: 'ui.bundle-corrupt',
            fields: { version: '1.1.0', reason: 'hash-mismatch' },
        });
    });

    it.each([
        ['invalid', async (path: string) => writeFile(path, '{"v":2}', { mode: 0o600 })],
        ['invalid', async (path: string) => writeFile(path, 'not json', { mode: 0o600 })],
        ['not-private', async (path: string) => writeFile(path, '{}', { mode: 0o644 })],
        ['too-large', async (path: string) => writeFile(path, ' '.repeat(9 * 1024 * 1024), { mode: 0o600 })],
    ])('starts without a bundle when active.json is %s, and logs it', async (reason, plant) => {
        await mkdir(uiDir(), { mode: 0o700 });
        await plant(join(uiDir(), ACTIVE_FILE));
        const logger = createMemoryLogger();
        const store = await openFsBundleStore({ dataDir, logger });
        expect(store.active()).toBeUndefined();
        expect(logger.entries).toContainEqual({ level: 'error', event: 'ui.store-unreadable', fields: { reason } });
    });

    it('drops a stored bundle whose id does not match its version and hash', async () => {
        const store = await openFsBundleStore({ dataDir, logger: createMemoryLogger() });
        const bundle = await install(store, '1.0.0');
        await rm(join(uiDir(), ACTIVE_FILE));
        await writeFile(
            join(uiDir(), ACTIVE_FILE),
            JSON.stringify({ v: 1, active: { ...bundle, id: '../x' }, previous: null }),
            { mode: 0o600 },
        );
        const logger = createMemoryLogger();
        expect((await openFsBundleStore({ dataDir, logger })).active()).toBeUndefined();
        expect(logger.entries).toContainEqual({
            level: 'error',
            event: 'ui.bundle-corrupt',
            fields: { version: '1.0.0', reason: 'id' },
        });
    });

    it('withdraws a revoked active bundle for the previous one, durably, and deletes it', async () => {
        const store = await openFsBundleStore({ dataDir, logger: createMemoryLogger() });
        const first = await install(store, '1.0.0');
        const second = await install(store, '1.1.0', [...TEST_BUNDLE_FILES, { path: 'x.txt', bytes: text('x') }]);
        expect(await store.withdraw((version) => version === '1.1.0')).toEqual(first);
        expect(store.active()).toEqual(first);
        expect(store.previous()).toBeUndefined();
        expect(await store.read(second, 'x.txt')).toBeUndefined();
        expect(await entries()).toEqual([ACTIVE_FILE, first.id].sort());
        const reopened = await openFsBundleStore({ dataDir, logger: createMemoryLogger() });
        expect(reopened.active()).toEqual(first);
        expect(reopened.previous()).toBeUndefined();
    });

    it('keeps no bundle once the active and the previous one are revoked, also after a restart', async () => {
        const store = await openFsBundleStore({ dataDir, logger: createMemoryLogger() });
        await install(store, '1.0.0');
        await install(store, '1.1.0', [...TEST_BUNDLE_FILES, { path: 'x.txt', bytes: text('x') }]);
        expect(await store.withdraw(() => true)).toBeUndefined();
        expect(store.active()).toBeUndefined();
        expect(store.previous()).toBeUndefined();
        expect(await entries()).toEqual([ACTIVE_FILE]);
        const logger = createMemoryLogger();
        const reopened = await openFsBundleStore({ dataDir, logger });
        expect(reopened.active()).toBeUndefined();
        expect(logger.entries).toEqual([]);
        const third = await install(reopened, '1.2.0');
        expect(reopened.active()).toEqual(third);
        expect(reopened.previous()).toBeUndefined();
    });

    it('drops only a revoked previous bundle, and changes nothing when nothing installed is revoked', async () => {
        const store = await openFsBundleStore({ dataDir, logger: createMemoryLogger() });
        const first = await install(store, '1.0.0');
        const second = await install(store, '1.1.0', [...TEST_BUNDLE_FILES, { path: 'x.txt', bytes: text('x') }]);
        const before = await stat(join(uiDir(), ACTIVE_FILE));
        expect(await store.withdraw(() => false)).toEqual(second);
        expect((await stat(join(uiDir(), ACTIVE_FILE))).mtimeMs).toBe(before.mtimeMs);
        expect(await entries()).toEqual([ACTIVE_FILE, first.id, second.id].sort());
        expect(await store.withdraw((version) => version === '1.0.0')).toEqual(second);
        expect(store.previous()).toBeUndefined();
        expect(await entries()).toEqual([ACTIVE_FILE, second.id].sort());
    });

    it('refuses a stored previous bundle without an active one', async () => {
        const store = await openFsBundleStore({ dataDir, logger: createMemoryLogger() });
        const bundle = await install(store, '1.0.0');
        await rm(join(uiDir(), ACTIVE_FILE));
        await writeFile(join(uiDir(), ACTIVE_FILE), JSON.stringify({ v: 1, active: null, previous: bundle }), {
            mode: 0o600,
        });
        const logger = createMemoryLogger();
        expect((await openFsBundleStore({ dataDir, logger })).active()).toBeUndefined();
        expect(logger.entries).toContainEqual({
            level: 'error',
            event: 'ui.store-unreadable',
            fields: { reason: 'invalid' },
        });
    });

    it('refuses a UI directory others can read', async () => {
        await mkdir(uiDir(), { mode: 0o755 });
        await chmod(uiDir(), 0o755);
        await expect(openFsBundleStore({ dataDir, logger: createMemoryLogger() })).rejects.toThrow(BundleStoreError);
    });
});
