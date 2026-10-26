import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findEngineKey, quietly, regularFiles, secretForms } from './support';

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ptbk-support-'));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

function engineKey() {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
    return {
        privateKey,
        pkcs8,
        seed: pkcs8.subarray(pkcs8.length - 32),
        publicKey: String(publicKey.export({ format: 'jwk' }).x),
    };
}

describe('findEngineKey', () => {
    it.each([
        ['PKCS#8 PEM', (key: ReturnType<typeof engineKey>) => key.privateKey.export({ type: 'pkcs8', format: 'pem' })],
        ['PKCS#8 DER', (key: ReturnType<typeof engineKey>) => key.pkcs8],
        ['a JWK', (key: ReturnType<typeof engineKey>) => JSON.stringify(key.privateKey.export({ format: 'jwk' }))],
        ['a raw seed', (key: ReturnType<typeof engineKey>) => key.seed],
        ['a hex seed', (key: ReturnType<typeof engineKey>) => key.seed.toString('hex')],
        ['a base64 seed', (key: ReturnType<typeof engineKey>) => `${key.seed.toString('base64')}\n`],
    ])('finds the key stored as %s, in a subdirectory', async (_format, encode) => {
        const key = engineKey();
        const other = engineKey();
        await mkdir(join(dir, 'keys'));
        await writeFile(join(dir, 'a-other.pem'), other.privateKey.export({ type: 'pkcs8', format: 'pem' }));
        await writeFile(join(dir, 'notes.txt'), 'nothing to see');
        await writeFile(join(dir, 'keys', 'engine'), encode(key));
        const found = await findEngineKey(dir, key.publicKey);
        expect(found?.path).toBe(join(dir, 'keys', 'engine'));
        expect(found?.seed.equals(key.seed)).toBe(true);
    });

    it('ignores other key types, large files and symbolic links', async () => {
        const key = engineKey();
        const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        await writeFile(join(dir, 'ec.pem'), ec.privateKey.export({ type: 'pkcs8', format: 'pem' }));
        await writeFile(join(dir, 'big'), Buffer.alloc(2 * 1024 * 1024));
        const elsewhere = await mkdtemp(join(tmpdir(), 'ptbk-elsewhere-'));
        await writeFile(join(elsewhere, 'key.pem'), key.privateKey.export({ type: 'pkcs8', format: 'pem' }));
        await symlink(join(elsewhere, 'key.pem'), join(dir, 'link.pem'));
        expect(await findEngineKey(dir, key.publicKey)).toBeNull();
        expect(await regularFiles(dir)).toEqual([join(dir, 'big'), join(dir, 'ec.pem')]);
        await rm(elsewhere, { recursive: true, force: true });
    });
});

describe('secretForms', () => {
    it('lists text, hex, base64 with and without padding, and base64url', () => {
        expect(secretForms('ab?')).toEqual(['ab?', '61623f', 'YWI/', 'YWI/', 'YWI_']);
        expect(secretForms(Uint8Array.of(255))).toEqual(['ff', '/w==', '/w', '_w']);
    });
});

describe('quietly', () => {
    it('ends early when the check is aborted', async () => {
        const controller = new AbortController();
        const waiting = quietly(60_000, controller.signal);
        controller.abort();
        await waiting;
    });
});
