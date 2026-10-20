import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveEngineId, utf8Encode, verifyEd25519 } from '@ptbk/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ENGINE_KEY_FILE, IdentityStoreError, createFsIdentityStore } from './fs-identity-store';

let root: string;
let dataDir: string;
let keyPath: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ptbk-identity-'));
    dataDir = join(root, 'data');
    keyPath = join(dataDir, ENGINE_KEY_FILE);
});

afterEach(async () => {
    vi.restoreAllMocks();
    await chmod(root, 0o700);
    await rm(root, { recursive: true, force: true });
});

function modeOf(path: string): Promise<number> {
    return stat(path).then((stats) => stats.mode & 0o777);
}

describe('createFsIdentityStore', () => {
    it('creates a 0700 directory and a 0600 PKCS#8 PEM key on first start', async () => {
        const identity = await createFsIdentityStore(join(dataDir, 'nested')).loadOrCreate();
        const nestedKey = join(dataDir, 'nested', ENGINE_KEY_FILE);
        expect(await modeOf(join(dataDir, 'nested'))).toBe(0o700);
        expect(await modeOf(nestedKey)).toBe(0o600);
        const pem = await readFile(nestedKey, 'utf8');
        expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----\n([A-Za-z0-9+/=]{1,64}\n)+-----END PRIVATE KEY-----\n$/);
        expect(identity.engineId).toBe(await deriveEngineId(identity.publicKey));
    });

    it('loads the same engine ID on the second start', async () => {
        const first = await createFsIdentityStore(dataDir).loadOrCreate();
        const pem = await readFile(keyPath, 'utf8');
        const second = await createFsIdentityStore(dataDir).loadOrCreate();
        expect(second.engineId).toBe(first.engineId);
        expect(second.publicKey).toEqual(first.publicKey);
        expect(await readFile(keyPath, 'utf8')).toBe(pem);
    });

    it('signs with the stored key, imported non-extractable', async () => {
        await createFsIdentityStore(dataDir).loadOrCreate();
        const importKey = vi.spyOn(crypto.subtle, 'importKey');
        const identity = await createFsIdentityStore(dataDir).loadOrCreate();
        const privateImports = importKey.mock.calls.filter(([format]) => format === 'pkcs8');
        expect(privateImports).toHaveLength(1);
        expect(privateImports[0]?.[3]).toBe(false);
        const message = utf8Encode('ptbk-test');
        expect(verifyEd25519(identity.publicKey, message, await identity.sign(message))).toBe(true);
    });

    it('keeps one key when two first starts race', async () => {
        const [a, b] = await Promise.all([
            createFsIdentityStore(dataDir).loadOrCreate(),
            createFsIdentityStore(dataDir).loadOrCreate(),
        ]);
        expect(a.engineId).toBe(b.engineId);
    });

    it('refuses a key file readable by others (0644)', async () => {
        await createFsIdentityStore(dataDir).loadOrCreate();
        await chmod(keyPath, 0o644);
        await expect(createFsIdentityStore(dataDir).loadOrCreate()).rejects.toThrow(
            new IdentityStoreError(
                `${ENGINE_KEY_FILE} ${keyPath} is accessible by group or others (mode 0644); run chmod 600 ${keyPath}`,
            ),
        );
    });

    it('refuses a data directory reachable by others (0755)', async () => {
        await mkdir(dataDir, { mode: 0o700 });
        await chmod(dataDir, 0o755);
        await expect(createFsIdentityStore(dataDir).loadOrCreate()).rejects.toThrow(
            `PTBK_DATA_DIR ${dataDir} is accessible by group or others (mode 0755); run chmod 700 ${dataDir}`,
        );
    });

    it('refuses a group-writable directory before creating a key in it', async () => {
        await mkdir(dataDir, { mode: 0o700 });
        await chmod(dataDir, 0o720);
        await expect(createFsIdentityStore(dataDir).loadOrCreate()).rejects.toBeInstanceOf(IdentityStoreError);
        await expect(stat(keyPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses a data directory that is a symbolic link', async () => {
        const target = join(root, 'target');
        await mkdir(target, { mode: 0o700 });
        await symlink(target, dataDir);
        await expect(createFsIdentityStore(dataDir).loadOrCreate()).rejects.toThrow(
            `PTBK_DATA_DIR ${dataDir} is not a directory (symbolic links are refused)`,
        );
    });

    it('refuses a data directory that is a file', async () => {
        await writeFile(dataDir, '', { mode: 0o600 });
        await expect(createFsIdentityStore(dataDir).loadOrCreate()).rejects.toThrow(
            `PTBK_DATA_DIR ${dataDir} is not a directory`,
        );
    });

    it('refuses a key that is a symbolic link', async () => {
        await mkdir(dataDir, { mode: 0o700 });
        const target = join(root, 'elsewhere.pem');
        await writeFile(target, '', { mode: 0o600 });
        await symlink(target, keyPath);
        await expect(createFsIdentityStore(dataDir).loadOrCreate()).rejects.toThrow(
            `${ENGINE_KEY_FILE} ${keyPath} is not a file (symbolic links are refused)`,
        );
    });

    it('refuses files owned by another user', async () => {
        const uid = (process.getuid?.() ?? 0) + 1;
        await expect(createFsIdentityStore(dataDir, { uid }).loadOrCreate()).rejects.toThrow(
            `PTBK_DATA_DIR ${dataDir} is not owned by the current user (uid ${String(uid)})`,
        );
    });

    it('skips the owner check when there is no uid', async () => {
        const identity = await createFsIdentityStore(dataDir, { uid: null }).loadOrCreate();
        expect(identity.engineId).toHaveLength(26);
    });

    it.each([
        ['not PEM', 'hello'],
        [
            'an EC key',
            generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }),
        ],
        ['an X25519 key', generateKeyPairSync('x25519').privateKey.export({ format: 'pem', type: 'pkcs8' })],
    ])('refuses a key file that is %s, without quoting it', async (_, contents) => {
        await mkdir(dataDir, { mode: 0o700 });
        await writeFile(keyPath, contents, { mode: 0o600 });
        const error = await createFsIdentityStore(dataDir)
            .loadOrCreate()
            .catch((caught: unknown) => caught);
        expect(error).toEqual(
            new IdentityStoreError(`${ENGINE_KEY_FILE} ${keyPath} is not an Ed25519 PKCS#8 PEM private key`),
        );
    });

    it('passes on filesystem errors other than a missing path', async () => {
        await writeFile(join(root, 'file'), '');
        await expect(createFsIdentityStore(join(root, 'file', 'data')).loadOrCreate()).rejects.toMatchObject({
            code: 'ENOTDIR',
        });
    });

    it.skipIf(process.getuid?.() === 0)('fails when the key cannot be created', async () => {
        await mkdir(dataDir, { mode: 0o500 });
        await expect(createFsIdentityStore(dataDir).loadOrCreate()).rejects.toMatchObject({ code: 'EACCES' });
    });
});
