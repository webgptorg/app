import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Role } from '@ptbk/engine-api';
import { z } from 'zod';

import type { PasskeyStore, StoredPasskey } from '../domain/gateway/passkey-gateway';
import { currentUid, lstatOrNull, privacyProblem, replacePrivateFile, syncDirectory } from './private-files';

export const PASSKEYS_FILE = 'passkeys.json';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_PASSKEYS = 200;
const B64 = (max: number) =>
    z
        .string()
        .regex(/^[A-Za-z0-9_-]+$/)
        .max(max);
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Iso = z.iso.datetime({ offset: false });

const StoredPasskeySchema = z.strictObject({
    credentialId: B64(1024),
    publicKey: B64(4096),
    counter: z.int().min(0),
    transports: z.array(z.string().max(32)).max(8),
    attachment: z.enum(['platform', 'cross-platform']).nullable(),
    backedUp: z.boolean(),
    passkeyId: Id,
    memberId: Id,
    name: z.string().min(1).max(128),
    createdAt: Iso,
    member: z.strictObject({ displayName: z.string().min(1).max(256), role: Role, createdAt: Iso }),
});

const PasskeysFile = z.strictObject({ v: z.literal(1), passkeys: z.array(StoredPasskeySchema).max(MAX_PASSKEYS) });

/** A passkeys file that cannot be trusted or read. Messages name the path, never its content. */
export class PasskeyStoreError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PasskeyStoreError';
    }
}

/**
 * `<dataDir>/passkeys.json`, mode 0600, replaced atomically on every change: public keys and counters only, which
 * are no secret but decide who may sign in, so a file that is not private to the engine's user is refused.
 */
export function createFsPasskeyStore(dataDir: string, options: { readonly uid?: number | null } = {}): PasskeyStore {
    const uid = options.uid === undefined ? currentUid() : options.uid;
    const path = join(dataDir, PASSKEYS_FILE);

    async function load(): Promise<StoredPasskey[]> {
        const stats = await lstatOrNull(path);
        if (stats === null) return [];
        const problem = privacyProblem(stats, { label: PASSKEYS_FILE, path, kind: 'file' }, uid);
        if (problem !== null) throw new PasskeyStoreError(problem);
        if (stats.size > MAX_FILE_BYTES) throw new PasskeyStoreError(`${PASSKEYS_FILE} ${path} is too large`);
        let json: unknown;
        try {
            json = JSON.parse(await readFile(path, 'utf8'));
        } catch {
            json = undefined;
        }
        const parsed = PasskeysFile.safeParse(json);
        if (!parsed.success) throw new PasskeyStoreError(`${PASSKEYS_FILE} ${path} is not a valid passkey list`);
        return parsed.data.passkeys;
    }

    async function save(passkeys: readonly StoredPasskey[]): Promise<void> {
        const file = PasskeysFile.parse({ v: 1, passkeys });
        await replacePrivateFile(path, `${JSON.stringify(file, null, 4)}\n`);
    }

    // Writes run one at a time, so an assertion's counter update never overwrites a registration.
    let queue: Promise<unknown> = Promise.resolve();
    const serially = <T>(task: () => Promise<T>): Promise<T> => {
        const result = queue.then(task, task);
        queue = result.catch(() => undefined);
        return result;
    };

    return {
        list: () => serially(load),
        add: (passkey) =>
            serially(async () => {
                const passkeys = await load();
                if (passkeys.some(({ credentialId }) => credentialId === passkey.credentialId)) {
                    throw new PasskeyStoreError('a passkey with this credential ID is already registered');
                }
                await save([...passkeys, passkey]);
            }),
        update: (credentialId, use) =>
            serially(async () => {
                const passkeys = await load();
                await save(
                    passkeys.map((passkey) =>
                        passkey.credentialId === credentialId ? { ...passkey, ...use } : passkey,
                    ),
                );
            }),
        clear: () =>
            serially(async () => {
                await rm(path, { force: true });
                await syncDirectory(dirname(path));
            }),
    };
}
