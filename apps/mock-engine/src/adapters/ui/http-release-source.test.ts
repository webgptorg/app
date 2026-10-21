import { EngineVersion } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import type { RELEASE_SOURCE_LIMITS } from './http-release-source';
import { ReleaseSourceError, createHttpReleaseSource } from './http-release-source';

const BASE = 'https://releases.ptbk.test/mirror/';
const v = EngineVersion.parse('1.2.3');
const signal = () => new AbortController().signal;

interface Served {
    readonly status?: number;
    readonly body?: BodyInit | null;
    readonly headers?: Record<string, string>;
}

function source(routes: Record<string, Served>, limits: Partial<typeof RELEASE_SOURCE_LIMITS> = {}) {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
        const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
        requests.push({ url, init });
        const served = routes[url.slice(BASE.length)];
        if (served === undefined) return Promise.resolve(new Response('missing', { status: 404 }));
        return Promise.resolve(
            new Response(served.body ?? null, { status: served.status ?? 200, headers: served.headers ?? {} }),
        );
    };
    return { requests, source: createHttpReleaseSource({ baseUrl: BASE, fetch, limits }) };
}

const json = (value: unknown): Served => ({ body: JSON.stringify(value) });

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('createHttpReleaseSource', () => {
    it('reads the store layout under the base URL, with a timeout signal and no redirects', async () => {
        const { source: store, requests } = source({
            'ui/latest.json': json({ version: '1.2.3' }),
            'release-log/ui-1.2.3.json': json({ v: 1, anything: true }),
            'release-log/revocations.json': json({ payloadType: 'x' }),
            'ui/1.2.3/engine-ui.tar.zst': { body: new Uint8Array([1, 2, 3]) },
        });
        expect(await store.latest(signal())).toBe('1.2.3');
        expect(await store.release(v, signal())).toEqual({ v: 1, anything: true });
        expect(await store.revocations(signal())).toEqual({ payloadType: 'x' });
        expect(await bytesOf(await store.artifact(v, 'engine-ui.tar.zst', signal()))).toEqual(
            new Uint8Array([1, 2, 3]),
        );
        expect(requests.map((request) => request.url)).toEqual([
            `${BASE}ui/latest.json`,
            `${BASE}release-log/ui-1.2.3.json`,
            `${BASE}release-log/revocations.json`,
            `${BASE}ui/1.2.3/engine-ui.tar.zst`,
        ]);
        for (const { init } of requests) {
            expect(init?.redirect).toBe('error');
            expect(init?.signal).toBeInstanceOf(AbortSignal);
        }
    });

    it('treats a missing revocation list as null, which verification refuses', async () => {
        expect(await source({}).source.revocations(signal())).toBeNull();
    });

    it('hands undecodable JSON on as undefined, for verifyRelease to refuse', async () => {
        const { source: store } = source({ 'release-log/ui-1.2.3.json': { body: '{' } });
        expect(await store.release(v, signal())).toBeUndefined();
    });

    it('throws for a missing release, a server error or a redirect', async () => {
        await expect(source({}).source.release(v, signal())).rejects.toThrow(ReleaseSourceError);
        await expect(source({ 'ui/latest.json': { status: 500 } }).source.latest(signal())).rejects.toThrow(
            'status 500',
        );
        await expect(
            source({ 'ui/latest.json': { status: 302, headers: { location: 'https://evil.test/' } } }).source.latest(
                signal(),
            ),
        ).rejects.toThrow('status 302');
        await expect(source({}).source.artifact(v, 'engine-ui.tar.zst', signal())).rejects.toThrow('status 404');
    });

    it('refuses a latest.json that is not exactly { version }', async () => {
        for (const value of [{ version: 'nope' }, { version: '1.0.0', extra: 1 }, []]) {
            await expect(source({ 'ui/latest.json': json(value) }).source.latest(signal())).rejects.toThrow(
                ReleaseSourceError,
            );
        }
    });

    it('caps every response, by Content-Length and while reading', async () => {
        const big = 'x'.repeat(2000);
        const declared = { body: big, headers: { 'content-length': '2000' } };
        await expect(source({ 'ui/latest.json': declared }).source.latest(signal())).rejects.toThrow('size cap');
        const streamed: Served = {
            body: new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(`"${big}`));
                    controller.close();
                },
            }),
        };
        await expect(source({ 'ui/latest.json': streamed }).source.latest(signal())).rejects.toThrow('size cap');
        const artifact = source({ 'ui/1.2.3/a.tar.zst': { body: new Uint8Array(64) } }, { artifactBytes: 16 }).source;
        await expect(bytesOf(await artifact.artifact(v, 'a.tar.zst', signal()))).rejects.toThrow('size cap');
        const declaredArtifact = source(
            { 'ui/1.2.3/a.tar.zst': { body: new Uint8Array(64), headers: { 'content-length': '64' } } },
            { artifactBytes: 16 },
        ).source;
        await expect(declaredArtifact.artifact(v, 'a.tar.zst', signal())).rejects.toThrow('size cap');
    });

    it('encodes the artifact name as one path segment', async () => {
        const { source: store, requests } = source({});
        await store.artifact(v, 'a b.tar.zst', signal()).catch(() => undefined);
        expect(requests[0]?.url).toBe(`${BASE}ui/1.2.3/a%20b.tar.zst`);
    });

    it('stops when the caller aborts', async () => {
        const controller = new AbortController();
        const store = createHttpReleaseSource({
            baseUrl: BASE,
            fetch: (_input, init) =>
                new Promise((_, reject) => {
                    init?.signal?.addEventListener('abort', () => {
                        reject(init.signal?.reason as Error);
                    });
                }),
        });
        const pending = store.latest(controller.signal);
        controller.abort(new Error('stop'));
        await expect(pending).rejects.toThrow('stop');
    });

    it('refuses a base URL whose path does not end in /', () => {
        expect(() => createHttpReleaseSource({ baseUrl: 'https://releases.ptbk.test/mirror', fetch })).toThrow(
            ReleaseSourceError,
        );
    });
});
