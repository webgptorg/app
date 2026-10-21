import type { JsonWebKey } from 'node:crypto';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createWebCryptoSigner, generateEd25519KeyPair } from '@ptbk/protocol';

import type { EngineIdentity, IdentityStore } from '../domain/identity/engine-identity';
import { engineIdentityFromSigner } from '../domain/identity/engine-identity';
import type { PrivatePath } from './private-files';
import {
    currentUid,
    ensurePrivateDirectory,
    lstatOrNull,
    privacyProblem,
    syncDirectory,
    writeNewPrivateFile,
} from './private-files';

export const ENGINE_KEY_FILE = 'engine-key.pem';

const PEM_LINE_LENGTH = 64;

/** Startup refusals. Messages name paths and modes, never key material. */
export class IdentityStoreError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'IdentityStoreError';
    }
}

export interface FsIdentityStoreOptions {
    /** Owner every file must have; null skips the check (platforms without uids). Defaults to the process's uid. */
    readonly uid?: number | null;
}

function assertPrivate(problem: string | null): void {
    if (problem !== null) throw new IdentityStoreError(problem);
}

function toPem(pkcs8: ArrayBuffer): string {
    const base64 = Buffer.from(pkcs8).toString('base64');
    const lines: string[] = [];
    for (let offset = 0; offset < base64.length; offset += PEM_LINE_LENGTH) {
        lines.push(base64.slice(offset, offset + PEM_LINE_LENGTH));
    }
    return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

/**
 * Writes a new key only if none exists; a concurrent first start that won the race keeps its key. The file and then
 * the directory are synced before the key is used, so a crash cannot leave an engine registered with a key it lost.
 */
async function createKey(path: string): Promise<void> {
    // Extractable only for this one export; the key is imported non-extractable when loaded.
    const keyPair = await generateEd25519KeyPair({ extractable: true });
    await writeNewPrivateFile(path, toPem(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)));
    await syncDirectory(dirname(path));
}

function parseKey(pem: string): { readonly der: Buffer; readonly jwk: JsonWebKey } | null {
    try {
        const privateKey = createPrivateKey({ key: pem, format: 'pem' });
        return {
            der: privateKey.export({ format: 'der', type: 'pkcs8' }),
            jwk: createPublicKey(privateKey).export({ format: 'jwk' }),
        };
    } catch {
        return null;
    }
}

async function loadKey(path: string): Promise<EngineIdentity> {
    const parsed = parseKey(await readFile(path, 'utf8'));
    if (parsed?.jwk.crv !== 'Ed25519' || typeof parsed.jwk.x !== 'string') {
        throw new IdentityStoreError(`${ENGINE_KEY_FILE} ${path} is not an Ed25519 PKCS#8 PEM private key`);
    }
    const [privateKey, publicKey] = await Promise.all([
        crypto.subtle.importKey('pkcs8', new Uint8Array(parsed.der), 'Ed25519', false, ['sign']),
        crypto.subtle.importKey('raw', new Uint8Array(Buffer.from(parsed.jwk.x, 'base64url')), 'Ed25519', true, [
            'verify',
        ]),
    ]);
    return engineIdentityFromSigner(await createWebCryptoSigner({ privateKey, publicKey }));
}

/**
 * Keeps the engine key in `<dataDir>/engine-key.pem` (PKCS#8 PEM, mode 0600) inside a 0700 directory, created on
 * first start. Throws an {@link IdentityStoreError} when either is reachable by anyone but the owner.
 */
export function createFsIdentityStore(dataDir: string, options: FsIdentityStoreOptions = {}): IdentityStore {
    const uid = options.uid === undefined ? currentUid() : options.uid;
    const keyPath = join(dataDir, ENGINE_KEY_FILE);
    const key: PrivatePath = { label: ENGINE_KEY_FILE, path: keyPath, kind: 'file' };
    return {
        async loadOrCreate() {
            assertPrivate(
                await ensurePrivateDirectory({ label: 'PTBK_DATA_DIR', path: dataDir, kind: 'directory' }, uid),
            );
            if ((await lstatOrNull(keyPath)) === null) await createKey(keyPath);
            assertPrivate(privacyProblem(await lstat(keyPath), key, uid));
            return loadKey(keyPath);
        },
    };
}
