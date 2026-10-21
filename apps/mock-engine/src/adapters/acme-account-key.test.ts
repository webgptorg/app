import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ACME_ACCOUNT_KEY_FILE, ACME_DIRECTORY, AcmeSetupError, loadOrCreateAcmeAccountKey } from './acme-account-key';
import { ENGINE_KEY_FILE, createFsIdentityStore } from './fs-identity-store';

let dataDir: string;
let keyPath: string;

beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ptbk-acme-key-'));
    keyPath = join(dataDir, ACME_DIRECTORY, ACME_ACCOUNT_KEY_FILE);
});

afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
});

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

describe('loadOrCreateAcmeAccountKey', () => {
    it('creates an ECDSA P-256 key once, 0600 in a 0700 directory, and loads the same one afterwards', async () => {
        const created = await loadOrCreateAcmeAccountKey(dataDir);
        expect(await modeOf(join(dataDir, ACME_DIRECTORY))).toBe(0o700);
        expect(await modeOf(keyPath)).toBe(0o600);
        expect(createPrivateKey(created.reveal()).asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
        expect((await loadOrCreateAcmeAccountKey(dataDir)).reveal()).toBe(created.reveal());
        expect(JSON.stringify({ created })).toBe('{"created":"[redacted]"}');
    });

    it('is not the engine key', async () => {
        await createFsIdentityStore(dataDir).loadOrCreate();
        const account = await loadOrCreateAcmeAccountKey(dataDir);
        const engineKey = await readFile(join(dataDir, ENGINE_KEY_FILE), 'utf8');
        expect(account.reveal()).not.toBe(engineKey);
        expect(createPrivateKey(engineKey).asymmetricKeyType).toBe('ed25519');
        expect(createPrivateKey(account.reveal()).asymmetricKeyType).toBe('ec');
    });

    it('refuses a key file others can read', async () => {
        await loadOrCreateAcmeAccountKey(dataDir);
        await chmod(keyPath, 0o644);
        await expect(loadOrCreateAcmeAccountKey(dataDir)).rejects.toThrow(AcmeSetupError);
    });

    it('refuses a directory others can enter', async () => {
        await mkdir(join(dataDir, ACME_DIRECTORY), { mode: 0o755 });
        await chmod(join(dataDir, ACME_DIRECTORY), 0o755);
        await expect(loadOrCreateAcmeAccountKey(dataDir)).rejects.toThrow(/accessible by group or others/);
    });

    it('refuses a key that is not ECDSA P-256, or not a key at all, without printing it', async () => {
        await mkdir(join(dataDir, ACME_DIRECTORY), { mode: 0o700 });
        const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
            type: 'pkcs8',
            format: 'pem',
        });
        await writeFile(keyPath, rsa, { mode: 0o600 });
        await expect(loadOrCreateAcmeAccountKey(dataDir)).rejects.toThrow('is not an ECDSA P-256 key');
        await writeFile(keyPath, 'not a key', { mode: 0o600 });
        const error = await loadOrCreateAcmeAccountKey(dataDir).catch((caught: unknown) => caught);
        expect((error as Error).message).toBe(`ACME account key ${keyPath} is not a PEM private key`);
    });
});
