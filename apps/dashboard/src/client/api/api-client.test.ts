import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineRoute, NO_INPUT } from '../../shared/api/contract';
import { apiRoutes } from '../../shared/api/routes';
import { createApiClient } from './api-client';

const ROUTE = { auth: 'session', permission: 'engine.read', rateLimit: null } as const;

const getEngine = defineRoute({
    ...ROUTE,
    method: 'GET',
    path: '/api/engines/:engineId',
    input: { ...NO_INPUT, params: z.strictObject({ engineId: z.string() }) },
    output: z.strictObject({
        engineId: z.string(),
        status: z.enum(['online', 'offline']),
        hostnames: z.array(z.strictObject({ name: z.string() })).optional(),
    }),
    errorCodes: ['engine-not-found'],
});

function respond(status: number, body: unknown, contentType = 'application/json') {
    const requests: Request[] = [];
    const client = createApiClient({
        fetch: (input, init) => {
            const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            requests.push(new Request(new URL(path, 'https://app.ptbk.test'), init));
            return Promise.resolve(
                new Response(typeof body === 'string' ? body : JSON.stringify(body), {
                    status,
                    headers: { 'Content-Type': contentType },
                }),
            );
        },
    });
    return { client, requests };
}

describe('API client', () => {
    it('returns parsed data for a response that matches the contract', async () => {
        const { client, requests } = respond(200, { engineId: 'a b', status: 'online' });
        expect(await client.call(getEngine, { params: { engineId: 'a b' } })).toEqual({
            kind: 'ok',
            data: { engineId: 'a b', status: 'online' },
        });
        expect(requests[0]?.url).toBe('https://app.ptbk.test/api/engines/a%20b');
        expect(requests[0]?.method).toBe('GET');
        expect(requests[0]?.credentials).toBe('same-origin');
    });

    it('reads responses tolerantly: unknown fields are dropped at every depth, known ones still validated', async () => {
        const { client } = respond(200, {
            engineId: 'e',
            status: 'online',
            addedLater: true,
            hostnames: [{ name: 'a.example', verifiedAt: 1 }, { name: 'b.example' }],
        });
        expect(await client.call(getEngine, { params: { engineId: 'e' } })).toEqual({
            kind: 'ok',
            data: { engineId: 'e', status: 'online', hostnames: [{ name: 'a.example' }, { name: 'b.example' }] },
        });
    });

    it.each([
        ['an unknown field next to a wrong type', { engineId: 'e', status: 'sleeping', addedLater: true }],
        ['a wrong nested type', { engineId: 'e', status: 'online', hostnames: [{ name: 1, extra: 1 }] }],
        ['a wrong type', { engineId: 'e', status: 'sleeping' }],
        ['a missing field', { engineId: 'e' }],
        ['HTML instead of JSON', '<!doctype html><html></html>'],
    ])('rejects a 200 response with %s', async (_, body) => {
        const { client } = respond(200, body);
        expect(await client.call(getEngine, { params: { engineId: 'e' } })).toEqual({
            kind: 'invalid-response',
            status: 200,
        });
    });

    it('returns a declared problem code, ignoring problem fields it does not know', async () => {
        const problem = { type: 'about:blank', title: 'Not Found', status: 404, code: 'engine-not-found', hint: 'x' };
        const { client } = respond(404, problem, 'application/problem+json');
        expect(await client.call(getEngine, { params: { engineId: 'e' } })).toEqual({
            kind: 'problem',
            status: 404,
            code: 'engine-not-found',
        });
    });

    it('rejects a problem whose code the contract does not declare', async () => {
        const problem = { type: 'about:blank', title: 'Gone', status: 410, code: 'engine-deleted' };
        const { client } = respond(410, problem, 'application/problem+json');
        expect((await client.call(getEngine, { params: { engineId: 'e' } })).kind).toBe('invalid-response');
    });

    it('builds the query string from defined values only', async () => {
        const listEngines = defineRoute({
            ...ROUTE,
            method: 'GET',
            path: '/api/engines',
            input: { ...NO_INPUT, query: z.strictObject({ status: z.string().optional(), q: z.string().optional() }) },
            output: z.strictObject({ engines: z.array(z.string()) }),
            errorCodes: [],
        });
        const { client, requests } = respond(200, { engines: [] });
        await client.call(listEngines, { query: { status: 'online' } });
        await client.call(listEngines, { query: {} });
        expect(requests.map((request) => request.url)).toEqual([
            'https://app.ptbk.test/api/engines?status=online',
            'https://app.ptbk.test/api/engines',
        ]);
    });

    it('sends a JSON body for contracts that declare one', async () => {
        const rename = defineRoute({
            ...ROUTE,
            method: 'POST',
            path: '/api/engines/:engineId/name',
            input: {
                ...NO_INPUT,
                params: z.strictObject({ engineId: z.string() }),
                body: z.strictObject({ name: z.string() }),
                maxBodyBytes: 1024,
            },
            output: z.strictObject({ name: z.string() }),
            errorCodes: [],
        });
        const { client, requests } = respond(200, { name: 'Office' });
        expect((await client.call(rename, { params: { engineId: 'e' }, body: { name: 'Office' } })).kind).toBe('ok');
        expect(requests[0]?.headers.get('Content-Type')).toBe('application/json');
        expect(await requests[0]?.json()).toEqual({ name: 'Office' });
    });

    it('treats a missing path parameter as a bug', async () => {
        const { client } = respond(200, {});
        const call = client.call(getEngine, { params: {} as { engineId: string } });
        await expect(call).rejects.toThrow(/engineId/);
    });

    it('reports a network failure as an outcome, not an exception', async () => {
        const client = createApiClient({ fetch: () => Promise.reject(new TypeError('offline')) });
        expect(await client.call(apiRoutes.getEnvironment, {})).toEqual({ kind: 'network-error' });
    });
});
