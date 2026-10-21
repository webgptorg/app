import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Secret } from '../domain/secret';
import { secret } from '../domain/secret';
import {
    currentUid,
    ensurePrivateDirectory,
    lstatOrNull,
    privacyProblem,
    syncDirectory,
    writeNewPrivateFile,
} from './private-files';

export const ACME_DIRECTORY = 'acme';
export const ACME_ACCOUNT_KEY_FILE = 'account-key.pem';

/** Names paths and modes, never key material. */
export class AcmeSetupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AcmeSetupError';
    }
}

function parseAccountKey(pem: string, path: string): Secret {
    let details;
    try {
        const key = createPrivateKey(pem);
        details = key.asymmetricKeyType === 'ec' ? key.asymmetricKeyDetails : undefined;
    } catch {
        throw new AcmeSetupError(`ACME account key ${path} is not a PEM private key`);
    }
    if (details?.namedCurve !== 'prime256v1') {
        throw new AcmeSetupError(`ACME account key ${path} is not an ECDSA P-256 key`);
    }
    return secret(pem);
}

/**
 * The ACME account key, `PTBK_DATA_DIR/acme/account-key.pem` (0600), created once. It is deliberately not the engine
 * key: the engine's Ed25519 identity signs only our own protocol, and an ACME account (ES256 here) is a separate
 * identity at the CA that can be rotated or revoked without touching the engine ID.
 */
export async function loadOrCreateAcmeAccountKey(dataDir: string): Promise<Secret> {
    const uid = currentUid();
    const directory = join(dataDir, ACME_DIRECTORY);
    const directoryProblem = await ensurePrivateDirectory(
        { label: 'ACME directory', path: directory, kind: 'directory' },
        uid,
    );
    if (directoryProblem !== null) throw new AcmeSetupError(directoryProblem);
    const path = join(directory, ACME_ACCOUNT_KEY_FILE);
    if ((await lstatOrNull(path)) === null) {
        const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' })
            .privateKey.export({ type: 'pkcs8', format: 'pem' })
            .toString();
        if (await writeNewPrivateFile(path, pem)) {
            await syncDirectory(directory);
            return secret(pem);
        }
    }
    const stats = await lstatOrNull(path);
    if (stats === null) throw new AcmeSetupError(`ACME account key ${path} disappeared while reading it`);
    const problem = privacyProblem(stats, { label: 'ACME account key', path, kind: 'file' }, uid);
    if (problem !== null) throw new AcmeSetupError(problem);
    return parseAccountKey(await readFile(path, 'utf8'), path);
}
