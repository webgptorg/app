import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { EngineVersion, UiBundleManifest, verifyManifestFiles } from '@ptbk/protocol';
import { readTree } from '@ptbk/release-tools';
import { z } from 'zod';

import type { Logger } from '../../domain/logger';
import type { BundleStore, InstalledBundle } from '../../domain/ui/bundle-store';
import { bundleId, withdrawn } from '../../domain/ui/bundle-store';
import { currentUid, ensurePrivateDirectory, lstatOrNull, privacyProblem, replacePrivateFile } from '../private-files';
import { makeReadOnly, removeTree, unpackBundle } from './bundle-unpacker';
import { UI_DIR, UPDATE_STATE_FILE } from './fs-update-state-store';

export const ACTIVE_FILE = 'active.json';
const STAGING_PREFIX = 'staging-';
const MAX_ACTIVE_FILE_BYTES = 8 * 1024 * 1024;

const StoredBundle = z.strictObject({
    id: z.string().max(300),
    version: EngineVersion,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    logIndex: z.int().min(0),
    manifest: UiBundleManifest,
});
/** `active: null` once every installed bundle was revoked; a previous bundle is only ever kept beside an active one. */
const StoredActive = z
    .strictObject({ v: z.literal(1), active: StoredBundle.nullable(), previous: StoredBundle.nullable() })
    .refine((stored) => stored.active !== null || stored.previous === null, 'a previous bundle needs an active one');

export class BundleStoreError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BundleStoreError';
    }
}

export interface FsBundleStoreOptions {
    readonly dataDir: string;
    readonly logger: Logger;
    readonly uid?: number | null;
}

/**
 * `<dataDir>/ui/`: each bundle unpacks into `staging-<random>/`, is read back for verification, then renamed to
 * `<version>-<sha256 prefix>/` and made read-only; `active.json` names the active and the previous bundle and is
 * replaced atomically. Anything else in the directory (failed staging, older bundles) is deleted. On open, every file
 * of both bundles is checked against its manifest again, so a bundle changed on disk is never served.
 */
export async function openFsBundleStore(options: FsBundleStoreOptions): Promise<BundleStore> {
    const { logger } = options;
    const uid = options.uid === undefined ? currentUid() : options.uid;
    const root = join(options.dataDir, UI_DIR);
    const problem = await ensurePrivateDirectory({ label: 'UI directory', path: root, kind: 'directory' }, uid);
    if (problem !== null) throw new BundleStoreError(problem);
    const activePath = join(root, ACTIVE_FILE);

    let { active, previous } = await loadActive(activePath, uid, logger);
    active = await intact(root, active, logger);
    previous = await intact(root, previous, logger);
    if (active === undefined) [active, previous] = [previous, undefined];
    await removeAllBut(root, [active, previous]);

    async function save(next: InstalledBundle | undefined, before: InstalledBundle | undefined): Promise<void> {
        const stored: z.input<typeof StoredActive> = { v: 1, active: next ?? null, previous: before ?? null };
        await replacePrivateFile(activePath, `${JSON.stringify(StoredActive.parse(stored))}\n`);
    }

    return {
        active: () => active,
        previous: () => previous,
        async stage(archive) {
            const stagingId = `${STAGING_PREFIX}${randomUUID()}`;
            const dir = join(root, stagingId);
            await mkdir(dir, { mode: 0o700 });
            try {
                const unpacked = await unpackBundle(archive, dir);
                if (unpacked.kind === 'refused') {
                    await removeTree(dir);
                    return { kind: 'unpack-failed', reason: unpacked.reason };
                }
                return {
                    kind: 'staged',
                    bundle: { stagingId, manifestBytes: unpacked.manifestBytes, files: unpacked.files },
                };
            } catch (error) {
                await removeTree(dir);
                throw error;
            }
        },
        async activate(stagingId, bundle) {
            if (!stagingId.startsWith(STAGING_PREFIX)) throw new BundleStoreError('not a staging directory');
            const installed: InstalledBundle = { ...bundle, id: bundleId(bundle.version, bundle.sha256) };
            const target = join(root, installed.id);
            await removeTree(target);
            await rename(join(root, stagingId), target);
            await makeReadOnly(target);
            await save(installed, active);
            [active, previous] = [installed, active];
            await removeAllBut(root, [active, previous]);
            return installed;
        },
        discard: (stagingId) => removeTree(join(root, stagingId)),
        async withdraw(isRevoked) {
            const next = withdrawn({ active, previous }, isRevoked);
            if (next.active === active && next.previous === previous) return active;
            // active.json first: a crash before the directories go leaves them unlisted, and the next open deletes them.
            await save(next.active, next.previous);
            ({ active, previous } = next);
            await removeAllBut(root, [active, previous]);
            return active;
        },
        async read(bundle, path) {
            if (!bundle.manifest.files.some((file) => file.path === path)) return undefined;
            try {
                return new Uint8Array(await readFile(join(root, bundle.id, path)));
            } catch {
                return undefined;
            }
        },
    };
}

async function loadActive(
    path: string,
    uid: number | null,
    logger: Logger,
): Promise<{ active: InstalledBundle | undefined; previous: InstalledBundle | undefined }> {
    const none = { active: undefined, previous: undefined };
    const stats = await lstatOrNull(path);
    if (stats === null) return none;
    if (privacyProblem(stats, { label: ACTIVE_FILE, path, kind: 'file' }, uid) !== null) {
        logger.error('ui.store-unreadable', { reason: 'not-private' });
        return none;
    }
    if (stats.size > MAX_ACTIVE_FILE_BYTES) {
        logger.error('ui.store-unreadable', { reason: 'too-large' });
        return none;
    }
    try {
        const parsed = StoredActive.safeParse(JSON.parse(await readFile(path, 'utf8')));
        if (parsed.success) {
            return { active: parsed.data.active ?? undefined, previous: parsed.data.previous ?? undefined };
        }
    } catch {
        // Unparseable JSON is the same as a schema mismatch.
    }
    logger.error('ui.store-unreadable', { reason: 'invalid' });
    return none;
}

async function intact(
    root: string,
    bundle: InstalledBundle | undefined,
    logger: Logger,
): Promise<InstalledBundle | undefined> {
    if (bundle === undefined) return undefined;
    if (bundle.id !== bundleId(bundle.version, bundle.sha256)) {
        logger.error('ui.bundle-corrupt', { version: bundle.version, reason: 'id' });
        return undefined;
    }
    try {
        const files = await readTree(join(root, bundle.id));
        const check = await verifyManifestFiles(bundle.manifest, new Map(files.map((file) => [file.path, file.bytes])));
        if (check.kind === 'ok') return bundle;
        logger.error('ui.bundle-corrupt', { version: bundle.version, reason: check.kind });
    } catch {
        logger.error('ui.bundle-corrupt', { version: bundle.version, reason: 'unreadable' });
    }
    return undefined;
}

async function removeAllBut(root: string, keep: readonly (InstalledBundle | undefined)[]): Promise<void> {
    const kept = new Set([ACTIVE_FILE, UPDATE_STATE_FILE, ...keep.flatMap((bundle) => (bundle ? [bundle.id] : []))]);
    for (const entry of await readdir(root, { withFileTypes: true })) {
        if (kept.has(entry.name) || entry.name.endsWith('.tmp')) continue;
        if (entry.isDirectory()) await removeTree(join(root, entry.name));
    }
}
