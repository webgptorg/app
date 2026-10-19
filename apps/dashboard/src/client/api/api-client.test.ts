import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineRoute } from '../../shared/api/contract';
import { apiRoutes } from '../../shared/api/routes';
import { createApiClient } from './api-client';

const getEngine = defineRoute({
    method: 'GET',
    path: '/api/engines/:engineId',
    params: z.strictObject({ engineId: z.string() }),
    query: null,
    body: null,
    response: z.strictObject({ engineId: z.string(), status: z.enum(['online', 'offline']) }),
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

    it.each([
        ['an unknown field', { engineId: 'e', status: 'online', prompt: 'leaked' }],
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

    it('returns a declared problem code', async () => {
        const problem = { type: 'about:blank', title: 'Not Found', status: 404, code: 'engine-not-found' };
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

    it('reports a network failure as an outcome, not an exception', async () => {
        const client = createApiClient({ fetch: () => Promise.reject(new TypeError('offline')) });
        expect(await client.call(apiRoutes.getEnvironment, {})).toEqual({ kind: 'network-error' });
    });
});
