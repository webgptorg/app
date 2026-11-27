import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import type { SetupSecretStore, StoredSetupSecret } from '../domain/onboarding/setup-secret';
import { currentUid, lstatOrNull, privacyProblem, replacePrivateFile, syncDirectory } from './private-files';

export const SETUP_SECRET_FILE = 'setup-secret.json';
/** The pairing tab's handoff slot (ADR 0023), kept apart so `setup-link` never touches it. */
export const OWNER_HANDOFF_FILE = 'owner-handoff.json';

const MAX_FILE_BYTES = 1024;

const StoredSecretFile = z.strictObject({
    v: z.literal(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    expiresAt: z.iso.datetime({ offset: false }),
});

/** A setup secret file that cannot be trusted or read. Messages name the path, never its content. */
export class SetupSecretStoreError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SetupSecretStoreError';
    }
}

function parse(text: string): StoredSetupSecret | null {
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        return null;
    }
    const parsed = StoredSecretFile.safeParse(json);
    return parsed.success
        ? Object.freeze({ sha256: parsed.data.sha256, expiresAtMs: Date.parse(parsed.data.expiresAt) })
        : null;
}

/**
 * `<dataDir>/setup-secret.json`, mode 0600, written atomically: the secret's digest and expiry, so a restart neither
 * forgets a link the operator just printed nor revives one. A file that is not private or not valid is refused.
 */
export function createFsSetupSecretStore(
    dataDir: string,
    options: { readonly uid?: number | null; readonly file?: string } = {},
): SetupSecretStore {
    const uid = options.uid === undefined ? currentUid() : options.uid;
    const file = options.file ?? SETUP_SECRET_FILE;
    const path = join(dataDir, file);
    return {
        async load() {
            const stats = await lstatOrNull(path);
            if (stats === null) return null;
            const problem = privacyProblem(stats, { label: file, path, kind: 'file' }, uid);
            if (problem !== null) throw new SetupSecretStoreError(problem);
            if (stats.size > MAX_FILE_BYTES) throw new SetupSecretStoreError(`${file} ${path} is too large`);
            const stored = parse(await readFile(path, 'utf8'));
            if (stored === null) throw new SetupSecretStoreError(`${file} ${path} is not a valid setup secret`);
            return stored;
        },
        async save(secret) {
            const file: z.input<typeof StoredSecretFile> = {
                v: 1,
                sha256: secret.sha256,
                expiresAt: new Date(secret.expiresAtMs).toISOString(),
            };
            await replacePrivateFile(path, `${JSON.stringify(StoredSecretFile.parse(file))}\n`);
        },
        async clear() {
            await rm(path, { force: true });
            await syncDirectory(dirname(path));
        },
    };
}
