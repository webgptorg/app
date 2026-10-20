import { describe, expect, it } from 'vitest';

import type { EngineApiTransport } from '../client';
import { ENGINE_API_PREFIX } from '../constants';
import { createProblem } from '../problem';
import { ENGINE_API_ROUTES } from '../routes';
import { createInMemoryEngineApiTransport } from '../testing/in-memory-transport';
import { createEngineApiHttpHandler, serveEngineApiRoute } from './serve';

const BASE = `https://engine.test${ENGINE_API_PREFIX}`;

function handler() {
    return createEngineApiHttpHandler(createInMemoryEngineApiTransport().transport);
}

async function problemOf(response: Response) {
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    return (await response.json()) as { status: number; code: string; errors?: { path: string }[] };
}

describe('HTTP binding', () => {
    it('answers 404 problem+json outside the prefix and for paths no route declares', async () => {
        const serve = handler();
        expect(await problemOf(await serve(new Request('https://engine.test/elsewhere')))).toMatchObject({
            status: 404,
            code: 'not-found',
        });
        expect((await problemOf(await serve(new Request(`${BASE}/nothing/here`)))).code).toBe('not-found');
        expect((await problemOf(await serve(new Request(`${BASE}/agents`, { method: 'PUT' })))).code).toBe('not-found');
        expect((await problemOf(await serve(new Request(`${BASE}/agents/%E0%A4%A`)))).code).toBe('not-found');
    });

    it('prefers literal segments over parameters', async () => {
        const response = await handler()(
            new Request(`${BASE}/agents/validate`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ source: 'Ada' }),
            }),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([]);
    });

    it('refuses repeated query parameters, other media types and broken JSON', async () => {
        const serve = handler();
        const repeated = await problemOf(await serve(new Request(`${BASE}/agents?limit=1&limit=2`)));
        expect(repeated).toMatchObject({ status: 400, code: 'validation-failed', errors: [{ path: 'query.limit' }] });
        const post = (body: string, type: string) =>
            serve(new Request(`${BASE}/folders`, { method: 'POST', headers: { 'content-type': type }, body }));
        expect(await problemOf(await post('{"name":"x"}', 'text/plain'))).toMatchObject({
            status: 415,
            code: 'unsupported-media-type',
        });
        expect(await problemOf(await post('{', 'application/json'))).toMatchObject({
            status: 400,
            errors: [{ path: 'body' }],
        });
        expect((await post('{"name":"x"}', 'application/json; charset=utf-8')).status).toBe(201);
        const upload = await serve(
            new Request(`${BASE}/files`, {
                method: 'POST',
                headers: { 'content-type': 'multipart/form-data' },
                body: 'x',
            }),
        );
        expect((await problemOf(upload)).code).toBe('unsupported-media-type');
    });

    it.each(['__proto__', 'constructor', 'toString'])(
        'refuses a query parameter named %s, alone or repeated, as an unknown field',
        async (name) => {
            const serve = handler();
            const unknown = await problemOf(await serve(new Request(`${BASE}/agents?${name}=x`)));
            expect(unknown).toMatchObject({ status: 400, code: 'validation-failed' });
            expect(unknown.errors?.map(({ path }) => path)).toEqual(['query']);
            const repeated = await problemOf(await serve(new Request(`${BASE}/agents?${name}=x&${name}=y`)));
            expect(repeated).toMatchObject({ status: 400, errors: [{ path: `query.${name}` }] });
        },
    );

    it('writes empty, binary and SSE answers with their headers', async () => {
        const { transport } = createInMemoryEngineApiTransport();
        const serve = createEngineApiHttpHandler(transport);
        const form = new FormData();
        form.set('file', new Blob(['hello']), 'hello.txt');
        form.set('name', 'hello.txt');
        form.set('purpose', 'upload');
        const uploaded = await serve(new Request(`${BASE}/files`, { method: 'POST', body: form }));
        expect(uploaded.status).toBe(201);
        const { id } = (await uploaded.json()) as { id: string };
        const content = await serve(new Request(`${BASE}/files/${id}/content`));
        expect(content.headers.get('content-type')).toBe('application/octet-stream');
        expect(await content.text()).toBe('hello');
        const deleted = await serve(new Request(`${BASE}/files/${id}`, { method: 'DELETE' }));
        expect(deleted.status).toBe(204);
        expect(await deleted.text()).toBe('');

        const abort = new AbortController();
        const events = await serve(new Request(`${BASE}/events`, { signal: abort.signal }));
        expect(events.headers.get('content-type')).toBe('text/event-stream');
        const reader = events.body?.getReader();
        const read = reader?.read();
        await serve(
            new Request(`${BASE}/folders`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'x' }),
            }),
        );
        const agent = await serve(
            new Request(`${BASE}/agents`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ source: 'Ada' }),
            }),
        );
        const { id: agentId } = (await agent.json()) as { id: string };
        const chunk = await read;
        expect(new TextDecoder().decode(chunk?.value)).toMatch(
            new RegExp(
                `^id: \\d+\nevent: agent\\.changed\ndata: \\{"type":"agent\\.changed","agentId":"${agentId}"\\}\n\n$`,
            ),
        );
        abort.abort();
        await reader?.cancel();
    });

    it('serves a route the caller matched, passing Last-Event-ID and the path parameters', async () => {
        const seen: unknown[] = [];
        const transport: EngineApiTransport = (route, request) => {
            seen.push([route.id, request]);
            return Promise.resolve({ kind: 'problem', problem: createProblem('not-found') });
        };
        const response = await serveEngineApiRoute(
            transport,
            ENGINE_API_ROUTES.streamChatReply,
            { chatId: 'chat-1', messageId: 'message-2' },
            new Request(`${BASE}/chats/chat-1/messages/message-2/stream?x=1`, { headers: { 'last-event-id': '7' } }),
        );
        expect(response.status).toBe(404);
        expect(seen).toEqual([
            [
                'streamChatReply',
                {
                    params: { chatId: 'chat-1', messageId: 'message-2' },
                    query: { x: '1' },
                    body: undefined,
                    lastEventId: '7',
                },
            ],
        ]);
    });
});
