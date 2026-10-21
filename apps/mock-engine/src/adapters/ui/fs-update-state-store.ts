import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import type { Logger } from '../../domain/logger';
import type { UpdateStateStore } from '../../domain/ui/update-state-store';
import { MAX_FIRST_SEEN_ENTRIES } from '../../domain/ui/update-state-store';
import { currentUid, ensurePrivateDirectory, lstatOrNull, privacyProblem, replacePrivateFile } from '../private-files';

export const UI_DIR = 'ui';
export const UPDATE_STATE_FILE = 'update-state.json';

const MAX_FILE_BYTES = 64 * 1024;
const Instant = z.iso.datetime({ offset: false });

const StoredUpdateState = z.strictObject({
    v: z.literal(1),
    /** Payload SHA-256 → first seen, oldest first. */
    firstSeen: z.array(z.tuple([z.string().regex(/^[0-9a-f]{64}$/), Instant])).max(MAX_FIRST_SEEN_ENTRIES),
    lastAcceptedRevocationIssuedAt: Instant.nullable(),
});
type StoredUpdateState = z.infer<typeof StoredUpdateState>;

export class UpdateStateStoreError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UpdateStateStoreError';
    }
}

export interface FsUpdateStateStoreOptions {
    readonly dataDir: string;
    readonly logger: Logger;
    /** A UI bundle is installed, so a missing file means it was lost, not that this is the first run. */
    readonly installed: boolean;
    readonly uid?: number | null;
}

type Loaded =
    { readonly kind: 'ok'; readonly state: StoredUpdateState } | { readonly kind: 'lost'; readonly reason: string };

async function load(path: string, uid: number | null, installed: boolean): Promise<Loaded> {
    const stats = await lstatOrNull(path);
    if (stats === null) {
        const empty = { v: 1 as const, firstSeen: [], lastAcceptedRevocationIssuedAt: null };
        return installed ? { kind: 'lost', reason: 'missing' } : { kind: 'ok', state: empty };
    }
    // A file someone else could have written could shorten a delay or replay an old revocation list.
    if (privacyProblem(stats, { label: UPDATE_STATE_FILE, path, kind: 'file' }, uid) !== null) {
        return { kind: 'lost', reason: 'not-private' };
    }
    if (stats.size > MAX_FILE_BYTES) return { kind: 'lost', reason: 'too-large' };
    try {
        const parsed = StoredUpdateState.safeParse(JSON.parse(await readFile(path, 'utf8')));
        return parsed.success ? { kind: 'ok', state: parsed.data } : { kind: 'lost', reason: 'invalid' };
    } catch {
        return { kind: 'lost', reason: 'unreadable' };
    }
}

/**
 * `<dataDir>/ui/update-state.json` (0600), replaced atomically and durably on every change, parsed strictly on load. A
 * lost or unreadable file starts empty: the delay restarts rather than shortening, and since that also resets rollback
 * protection for revocation lists, it is logged as an error.
 */
export async function openFsUpdateStateStore(options: FsUpdateStateStoreOptions): Promise<UpdateStateStore> {
    const uid = options.uid === undefined ? currentUid() : options.uid;
    const dir = join(options.dataDir, UI_DIR);
    const problem = await ensurePrivateDirectory({ label: 'UI directory', path: dir, kind: 'directory' }, uid);
    if (problem !== null) throw new UpdateStateStoreError(problem);
    const path = join(dir, UPDATE_STATE_FILE);
    const loaded = await load(path, uid, options.installed);
    if (loaded.kind === 'lost') options.logger.error('ui.update-state-lost', { reason: loaded.reason });
    const firstSeen = new Map<string, string>(loaded.kind === 'ok' ? loaded.state.firstSeen : []);
    let lastAccepted = loaded.kind === 'ok' ? loaded.state.lastAcceptedRevocationIssuedAt : null;
    let queue: Promise<unknown> = Promise.resolve();

    function persist(): Promise<void> {
        const state: StoredUpdateState = {
            v: 1,
            firstSeen: [...firstSeen],
            lastAcceptedRevocationIssuedAt: lastAccepted,
        };
        return replacePrivateFile(path, `${JSON.stringify(state)}\n`);
    }

    function serial<T>(task: () => Promise<T>): Promise<T> {
        const result = queue.then(task);
        queue = result.catch(() => undefined);
        return result;
    }

    return {
        firstSeenAt(key, now) {
            return serial(async () => {
                const seen = firstSeen.get(key);
                if (seen !== undefined) return new Date(seen);
                firstSeen.set(key, now.toISOString());
                for (const oldest of firstSeen.keys()) {
                    if (firstSeen.size <= MAX_FIRST_SEEN_ENTRIES) break;
                    firstSeen.delete(oldest);
                }
                await persist();
                return now;
            });
        },
        lastAcceptedRevocationIssuedAt: () =>
            serial(() => Promise.resolve(lastAccepted === null ? null : new Date(lastAccepted))),
        acceptRevocations(issuedAt) {
            return serial(async () => {
                if (lastAccepted !== null && issuedAt.getTime() <= Date.parse(lastAccepted)) return;
                lastAccepted = issuedAt.toISOString();
                await persist();
            });
        },
    };
}
