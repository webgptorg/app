import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { HttpRoute, RouteBody } from './route';
import { defineHttpRoute } from './route';
import { bySpecificity, honoPath, rateLimited, runHttpRoute } from './route-handler';

const URL_BASE = 'https://engine.test';

function route(body: RouteBody | null, params: z.ZodObject | null = null): HttpRoute {
    return defineHttpRoute({
        transport: 'http',
        method: 'POST',
        path: '/things/{thingId}',
        auth: 'public',
        permission: null,
        rateLimit: 'spike-ip',
        params,
        query: z.strictObject({ mode: z.enum(['a', 'b']).optional() }),
        headers: z.strictObject({ 'x-tag': z.string().max(4).optional() }),
        body,
        handle: async ({ body: parsed, params: parsedParams, query, headers, request }) =>
            Response.json({ body: parsed, params: parsedParams, query, headers, copy: await request.text() }),
    });
}

const json = (schema: z.ZodType = z.strictObject({ name: z.string() }), maxBytes = 64): RouteBody => ({
    kind: 'json',
    schema,
    maxBytes,
});

async function run(target: HttpRoute, init: RequestInit & { readonly path?: string } = {}, params = {}) {
    const response = await runHttpRoute(target, {
        request: new Request(`${URL_BASE}${init.path ?? '/things/t1'}`, { method: 'POST', ...init }),
        params,
        connection: null,
        clientIp: '127.0.0.1',
        actor: null,
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const streamOf = (chunks: readonly string[]) =>
    new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
        },
    });

describe('runHttpRoute', () => {
    it('hands the handler parsed input and a re-readable copy of the request', async () => {
        const result = await run(
            route(json(), z.strictObject({ thingId: z.string().min(2) })),
            {
                path: '/things/t1?mode=a',
                headers: { 'content-type': 'application/json; charset=utf-8', 'x-tag': 'ok' },
                body: '{"name":"x"}',
            },
            { thingId: 't1' },
        );
        expect(result).toEqual({
            status: 200,
            body: {
                body: { name: 'x' },
                params: { thingId: 't1' },
                query: { mode: 'a' },
                headers: { 'x-tag': 'ok' },
                copy: '{"name":"x"}',
            },
        });
    });

    it('refuses invalid params, query and headers with the paths that failed', async () => {
        const target = route(null, z.strictObject({ thingId: z.string().min(5) }));
        expect((await run(target, {}, { thingId: 'x' })).body).toMatchObject({
            code: 'validation-failed',
            errors: [{ path: 'params.thingId' }],
        });
        expect((await run(target, { path: '/things/t?mode=c&extra=1' }, { thingId: 'thing1' })).body).toMatchObject({
            errors: [{ path: 'query.mode' }, { path: 'query' }],
        });
        expect((await run(target, { path: '/things/t?mode=a&mode=b' }, { thingId: 'thing1' })).body).toMatchObject({
            detail: 'repeated query parameter',
        });
        expect((await run(target, { headers: { 'x-tag': 'too-long' } }, { thingId: 'thing1' })).body).toMatchObject({
            errors: [{ path: 'headers.x-tag' }],
        });
    });

    it('caps the body by Content-Length and by what actually arrives', async () => {
        const target = route(json(z.unknown(), 16));
        expect(
            await run(target, { headers: { 'content-type': 'application/json', 'content-length': '17' }, body: '{}' }),
        ).toMatchObject({ status: 413, body: { code: 'payload-too-large' } });
        const streamed = await run(target, {
            headers: { 'content-type': 'application/json' },
            body: streamOf(['{"a":"', 'x'.repeat(20), '"}']),
            duplex: 'half',
        } as RequestInit);
        expect(streamed.status).toBe(413);
        const fits = await run(target, {
            headers: { 'content-type': 'application/json' },
            body: streamOf(['{"a"', ':1}']),
            duplex: 'half',
        } as RequestInit);
        expect(fits).toMatchObject({ status: 200, body: { body: { a: 1 } } });
    });

    it('refuses other media types and broken JSON', async () => {
        const target = route(json());
        expect(
            (await run(target, { headers: { 'content-type': 'text/plain' }, body: '{"name":"x"}' })).body,
        ).toMatchObject({
            code: 'unsupported-media-type',
        });
        expect((await run(target, { body: '{"name":"x"}' })).status).toBe(415);
        expect((await run(target, { headers: { 'content-type': 'application/json' }, body: '{' })).body).toMatchObject({
            errors: [{ path: 'body', message: 'Body is not valid JSON' }],
        });
        expect(
            (await run(target, { headers: { 'content-type': 'application/json' }, body: '{"name":1,"x":2}' })).body,
        ).toMatchObject({ errors: [{ path: 'body.name' }, { path: 'body' }] });
    });

    it('reads forms, refusing repeated fields and other media types', async () => {
        const target = route({ kind: 'form', schema: z.strictObject({ memberId: z.string() }), maxBytes: 64 });
        const form = { 'content-type': 'application/x-www-form-urlencoded' };
        expect(await run(target, { headers: form, body: 'memberId=m1' })).toMatchObject({
            status: 200,
            body: { body: { memberId: 'm1' } },
        });
        expect((await run(target, { headers: form, body: 'memberId=m1&memberId=m2' })).body).toMatchObject({
            errors: [{ path: 'body.memberId', message: 'Repeated field' }],
        });
        expect((await run(target, { headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(415);
    });

    it('reads multipart bodies and refuses broken ones', async () => {
        const target = route({
            kind: 'multipart',
            schema: z.strictObject({ name: z.string(), file: z.instanceof(Blob) }),
            maxBytes: 4096,
        });
        const data = new FormData();
        data.set('name', 'hello.txt');
        data.set('file', new Blob(['hello']), 'hello.txt');
        const accepted = await run(target, { body: data });
        expect(accepted.status).toBe(200);
        expect((accepted.body['body'] as Record<string, unknown>)['name']).toBe('hello.txt');
        expect((await run(target, { headers: { 'content-type': 'multipart/form-data' }, body: 'x' })).status).toBe(415);
    });

    it('refuses a body on a route that takes none, but accepts an empty one', async () => {
        const target = route(null);
        expect((await run(target, { body: '{}' })).body).toMatchObject({
            code: 'validation-failed',
            errors: [{ path: 'body', message: 'Not allowed for this route.' }],
        });
        expect((await run(target, { body: '' })).status).toBe(200);
        expect((await run(target, { body: 'x'.repeat(2048) })).status).toBe(413);
    });
});

describe('route helpers', () => {
    it('turns placeholders into Hono parameters and sorts literal routes first', () => {
        expect(honoPath('/agents/{agentId}/revisions/{revisionId}')).toBe('/agents/:agentId/revisions/:revisionId');
        const shaped = (path: `/${string}`) => ({ ...route(null), path });
        const sorted = [shaped('/runs/{runId}'), shaped('/runs/stats'), shaped('/a/b/c')].sort(bySpecificity);
        expect(sorted.map(({ path }) => path)).toEqual(['/a/b/c', '/runs/stats', '/runs/{runId}']);
    });

    it('reports a rate limit with Retry-After in whole seconds, at least one', () => {
        const limited = (retryAfterMs: number) =>
            rateLimited(route(null), { consume: () => ({ kind: 'limited', retryAfterMs }) }, '127.0.0.1');
        expect(limited(1)).toEqual({ code: 'rate-limited', retryAfterS: 1 });
        expect(limited(2_500)).toEqual({ code: 'rate-limited', retryAfterS: 3 });
        expect(rateLimited(route(null), { consume: () => ({ kind: 'allowed' }) }, '127.0.0.1')).toBeNull();
    });
});
