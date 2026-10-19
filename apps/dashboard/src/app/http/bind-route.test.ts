import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineRoute } from '../../shared/api/contract';
import { bindRoute } from './bind-route';

const renameEngine = defineRoute({
    method: 'POST',
    path: '/api/engines/:engineId/name',
    params: z.strictObject({ engineId: z.string().regex(/^[a-z2-7]{26}$/) }),
    query: z.strictObject({ dryRun: z.enum(['true', 'false']).optional() }),
    body: z.strictObject({ name: z.string().min(1).max(64) }),
    response: z.strictObject({ name: z.string() }),
    errorCodes: ['engine-not-found'],
});

const ENGINE = 'a'.repeat(26);

function app() {
    const router = new Hono();
    const seen: unknown[] = [];
    bindRoute(router, '/api', renameEngine, (input) => {
        seen.push(input);
        return Promise.resolve(
            input.body.name === 'missing'
                ? { kind: 'problem', status: 404, code: 'engine-not-found' }
                : { kind: 'ok', body: { name: input.body.name } },
        );
    });
    return { router: new Hono().route('/api', router), seen };
}

function post(router: Hono, path: string, body: string): Promise<Response> {
    return Promise.resolve(
        router.request(path, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }),
    );
}

describe('bindRoute', () => {
    it('passes validated params, query and body to the handler', async () => {
        const { router, seen } = app();
        const response = await post(router, `/api/engines/${ENGINE}/name?dryRun=true`, '{"name":"Office"}');
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ name: 'Office' });
        expect(seen).toEqual([{ params: { engineId: ENGINE }, query: { dryRun: 'true' }, body: { name: 'Office' } }]);
    });

    it('answers a declared error code as problem+json', async () => {
        const response = await post(app().router, `/api/engines/${ENGINE}/name`, '{"name":"missing"}');
        expect(response.status).toBe(404);
        expect(response.headers.get('Content-Type')).toBe('application/problem+json');
        expect(await response.json()).toMatchObject({ status: 404, code: 'engine-not-found' });
    });

    it.each([
        ['a bad param', `/api/engines/NOT-AN-ID/name`, '{"name":"Office"}'],
        ['an unknown query field', `/api/engines/${ENGINE}/name?debug=1`, '{"name":"Office"}'],
        ['an unknown body field', `/api/engines/${ENGINE}/name`, '{"name":"Office","isAdmin":true}'],
        ['malformed JSON', `/api/engines/${ENGINE}/name`, '{"name":<script>'],
    ])('rejects %s before the handler runs, without echoing input', async (_, path, body) => {
        const { router, seen } = app();
        const response = await post(router, path, body);
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(JSON.parse(text)).toMatchObject({ status: 400, code: 'invalid-request' });
        expect(text).not.toContain('script');
        expect(text).not.toContain('isAdmin');
        expect(seen).toEqual([]);
    });
});
