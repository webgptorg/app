import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TrustedRootsError, loadTrustedRoots } from './extra-ca';

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ptbk-ca-'));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('loadTrustedRoots', () => {
    it("keeps Node's defaults without an extra CA", async () => {
        expect(await loadTrustedRoots(null)).toBeUndefined();
    });

    it("adds the extra CA to Node's default roots", async () => {
        const pem = rootCertificates[0] ?? '';
        const file = join(dir, 'ca.pem');
        await writeFile(file, pem);
        const roots = await loadTrustedRoots(file);
        expect(roots).toEqual([...rootCertificates, pem]);
        expect(Object.isFrozen(roots)).toBe(true);
    });

    it('fails clearly on a missing file', async () => {
        const file = join(dir, 'missing.pem');
        await expect(loadTrustedRoots(file)).rejects.toThrow(
            new TrustedRootsError(`MOCK_EXTRA_CA_FILE ${file} cannot be read`),
        );
    });

    it.each([
        ['not PEM', 'hello'],
        ['a broken certificate', '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n'],
    ])('fails clearly on %s', async (_, contents) => {
        const file = join(dir, 'ca.pem');
        await writeFile(file, contents);
        await expect(loadTrustedRoots(file)).rejects.toThrow(
            new TrustedRootsError(`MOCK_EXTRA_CA_FILE ${file} is not a PEM certificate`),
        );
    });
});
