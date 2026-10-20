import type { JsonWebKey } from 'node:crypto';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createWebCryptoSigner, generateEd25519KeyPair } from '@ptbk/protocol';

import type { EngineIdentity, IdentityStore } from '../domain/identity/engine-identity';
import { engineIdentityFromSigner } from '../domain/identity/engine-identity';

export const ENGINE_KEY_FILE = 'engine-key.pem';

const PRIVATE_TO_OWNER = 0o077;
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

interface Checked {
    readonly label: string;
    readonly path: string;
    readonly kind: 'directory' | 'file';
    readonly fixMode: string;
}

function currentUid(): number | null {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

function octal(mode: number): string {
    return (mode & 0o777).toString(8).padStart(4, '0');
}

async function lstatOrNull(path: string): Promise<Stats | null> {
    try {
        return await lstat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

/** Like OpenSSH with its keys: refuse to run with a key anyone but its owner could read or swap. */
function assertPrivate(stats: Stats, checked: Checked, uid: number | null): void {
    const { label, path, kind, fixMode } = checked;
    const isKind = kind === 'directory' ? stats.isDirectory() : stats.isFile();
    if (!isKind) throw new IdentityStoreError(`${label} ${path} is not a ${kind} (symbolic links are refused)`);
    if (uid !== null && stats.uid !== uid) {
        throw new IdentityStoreError(`${label} ${path} is not owned by the current user (uid ${String(uid)})`);
    }
    if ((stats.mode & PRIVATE_TO_OWNER) !== 0) {
        throw new IdentityStoreError(
            `${label} ${path} is accessible by group or others (mode ${octal(stats.mode)}); run chmod ${fixMode} ${path}`,
        );
    }
}

function toPem(pkcs8: ArrayBuffer): string {
    const base64 = Buffer.from(pkcs8).toString('base64');
    const lines: string[] = [];
    for (let offset = 0; offset < base64.length; offset += PEM_LINE_LENGTH) {
        lines.push(base64.slice(offset, offset + PEM_LINE_LENGTH));
    }
    return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

/** Writes a new key only if none exists; a concurrent first start that won the race keeps its key. */
async function createKey(path: string): Promise<void> {
    // Extractable only for this one export; the key is imported non-extractable when loaded.
    const keyPair = await generateEd25519KeyPair({ extractable: true });
    const pem = toPem(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
    let file;
    try {
        file = await open(path, 'wx', 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
        throw error;
    }
    try {
        await file.writeFile(pem);
    } finally {
        await file.close();
    }
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
    const dir: Checked = { label: 'PTBK_DATA_DIR', path: dataDir, kind: 'directory', fixMode: '700' };
    const keyPath = join(dataDir, ENGINE_KEY_FILE);
    const key: Checked = { label: ENGINE_KEY_FILE, path: keyPath, kind: 'file', fixMode: '600' };
    return {
        async loadOrCreate() {
            let dirStats = await lstatOrNull(dataDir);
            if (dirStats === null) {
                await mkdir(dataDir, { recursive: true, mode: 0o700 });
                dirStats = await lstat(dataDir);
            }
            assertPrivate(dirStats, dir, uid);
            if ((await lstatOrNull(keyPath)) === null) await createKey(keyPath);
            assertPrivate(await lstat(keyPath), key, uid);
            return loadKey(keyPath);
        },
    };
}
