import type { IncomingHttpHeaders } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RELEASE_FILES } from './paths.ts';
import type { R2Target } from './r2.ts';
import { publishRelease, releaseUploads, runCurl } from './r2.ts';

interface Request {
    readonly method: string;
    readonly url: string;
    readonly headers: IncomingHttpHeaders;
    readonly body: string;
}

let dir: string;
let requests: Request[];
let existing: Set<string>;
let putStatus: number;
let close: () => Promise<void>;
let target: R2Target;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ptbk-r2-'));
    for (const name of Object.values(RELEASE_FILES)) await writeFile(join(dir, name), `content of ${name}`);
    requests = [];
    existing = new Set();
    putStatus = 200;
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
        });
        request.on('end', () => {
            const url = request.url ?? '';
            requests.push({
                method: request.method ?? '',
                url,
                headers: request.headers,
                body: Buffer.concat(chunks).toString(),
            });
            if (request.method === 'HEAD') response.statusCode = existing.has(url) ? 200 : 404;
            else response.statusCode = putStatus;
            response.end();
        });
    });
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    target = {
        endpoint: `http://127.0.0.1:${String(port)}`,
        bucket: 'ptbk-staging',
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'c2VjcmV0LWV4YW1wbGU=',
    };
    close = () =>
        new Promise((resolve) => {
            server.close(() => {
                resolve();
            });
        });
});
afterEach(async () => {
    await close();
    await rm(dir, { recursive: true, force: true });
});

// Each case spawns real curl processes, which is slow on a loaded machine.
describe('publishRelease with curl --aws-sigv4', { timeout: 30_000 }, () => {
    it('uploads every file after checking none exists, the release log entry last', async () => {
        const outcome = await publishRelease(target, releaseUploads(dir, '0.1.0'));
        expect(outcome).toMatchObject({ kind: 'published' });
        expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
            'HEAD /ptbk-staging/ui/0.1.0/engine-ui.tar.zst',
            'HEAD /ptbk-staging/ui/0.1.0/manifest.json',
            'HEAD /ptbk-staging/ui/0.1.0/engine-ui.tar.zst.sigstore.json',
            'HEAD /ptbk-staging/release-log/ui-0.1.0.json',
            'PUT /ptbk-staging/ui/0.1.0/engine-ui.tar.zst',
            'PUT /ptbk-staging/ui/0.1.0/manifest.json',
            'PUT /ptbk-staging/ui/0.1.0/engine-ui.tar.zst.sigstore.json',
            'PUT /ptbk-staging/release-log/ui-0.1.0.json',
        ]);
        const lastPut = requests.at(-1);
        expect(lastPut?.body).toBe('content of release.json');
        expect(lastPut?.headers['if-none-match']).toBe('*');
        expect(lastPut?.headers['content-type']).toBe('application/json');
        expect(lastPut?.headers['x-amz-content-sha256']).toBeDefined();
        expect(lastPut?.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\//);
    });

    it('fails without overwriting when the version exists', async () => {
        existing.add('/ptbk-staging/release-log/ui-0.1.0.json');
        const outcome = await publishRelease(target, releaseUploads(dir, '0.1.0'));
        expect(outcome).toEqual({ kind: 'exists', key: 'release-log/ui-0.1.0.json' });
        expect(requests.filter(({ method }) => method === 'PUT')).toEqual([]);
    });

    it('stops when a concurrent publish wins the conditional PUT', async () => {
        putStatus = 412;
        const outcome = await publishRelease(target, releaseUploads(dir, '0.1.0'));
        expect(outcome).toEqual({ kind: 'exists', key: 'ui/0.1.0/engine-ui.tar.zst' });
        expect(requests.filter(({ method }) => method === 'PUT')).toHaveLength(1);
    });

    it('fails on any other answer', async () => {
        putStatus = 500;
        await expect(publishRelease(target, releaseUploads(dir, '0.1.0'))).rejects.toThrow(/answered 500/);
        await expect(publishRelease(target, releaseUploads(dir, '0.1.0'), () => Promise.resolve(403))).rejects.toThrow(
            /HEAD .* answered 403/,
        );
    });

    it('refuses credentials that could break out of the curl config and unsafe keys', async () => {
        await expect(publishRelease({ ...target, secretAccessKey: 'a"\nurl = "x' }, [])).rejects.toThrow(/credentials/);
        await expect(
            publishRelease(target, [{ key: '../x', file: join(dir, RELEASE_FILES.archive), contentType: 'x' }]),
        ).rejects.toThrow(/unsafe object key/);
    });

    it('rejects when curl cannot connect', async () => {
        await expect(runCurl(['--silent', '--write-out', '%{http_code}', 'http://127.0.0.1:1/'], '')).rejects.toThrow(
            /curl failed/,
        );
    });
});
