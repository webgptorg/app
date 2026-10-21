import { ENGINE_API_ROUTES } from '@ptbk/engine-api';
import type { RouteDefinition } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { CheckFailure } from '../../check';
import { createSeededRandom } from '../../random';
import type { RawResponse } from './api';
import { EngineApi, issuesOf, judge, successOf } from './api';

const R = ENGINE_API_ROUTES;

function raw(status: number, body: string, headers: Record<string, string> = {}): RawResponse {
    return { status, headers: new Headers(headers), bytes: new TextEncoder().encode(body) };
}

function apiAnswering(answer: (request: Request) => Response | Promise<Response>, bearer = false) {
    const requests: Request[] = [];
    const api = new EngineApi(
        {
            target: {
                baseUrl: new URL('https://engine.test'),
                fetch: (input, init) => {
                    const request = new Request(input, init);
                    requests.push(request);
                    return Promise.resolve(answer(request));
                },
                session: () => Promise.resolve(null),
            },
            signal: new AbortController().signal,
        },
        bearer ? { bearer: 'token' } : null,
    );
    return { api, requests };
}

const failure = (fn: () => unknown) => {
    expect(fn).toThrow(CheckFailure);
};

describe('judge', () => {
    it('refuses a success without a body type, an empty route with a body and SSE without its type', () => {
        failure(() => judge(R.getMe, raw(200, '{}')));
        failure(() => judge(R.deleteFolder, raw(204, 'x')));
        failure(() => judge(R.streamEvents, raw(200, '')));
        expect(judge(R.streamEvents, raw(200, '', { 'content-type': 'text/event-stream' })).kind).toBe('ok');
        expect(judge(R.deleteFolder, raw(204, '')).kind).toBe('ok');
    });

    it('refuses a failure without a problem type, with invalid UTF-8, or one that is not a problem at all', () => {
        failure(() => judge(R.getMe, raw(500, '{}')));
        failure(() =>
            judge(R.getMe, {
                ...raw(500, ''),
                headers: new Headers({ 'content-type': 'application/problem+json' }),
                bytes: new Uint8Array([0xff]),
            }),
        );
        failure(() => judge(R.getMe, raw(204, '')));
        failure(() => judge(R.getMe, raw(601, '')));
    });

    it('needs exactly one declared success', () => {
        const route: RouteDefinition = { ...R.getMe, responses: {} };
        expect(() => successOf(route)).toThrow('declares no success response');
    });

    it('summarises at most five issues', () => {
        const issues = Array.from({ length: 7 }, (_, index) => ({
            path: index === 0 ? [] : ['a', index],
            message: 'm',
        }));
        expect(issuesOf(issues)).toBe('(root): m; a.1: m; a.2: m; a.3: m; a.4: m; +2 more');
    });
});

describe('EngineApi', () => {
    it('sends a bearer credential, the browser headers and drops undefined query values', async () => {
        const { api, requests } = apiAnswering(() => Response.json({ items: [], nextCursor: null }), true);
        await api.ok(R.listFolders, { query: { limit: 2, cursor: undefined } });
        const [request] = requests;
        expect(request?.headers.get('authorization')).toBe('Bearer token');
        expect(request?.headers.get('origin')).toBe('https://engine.test');
        expect(request?.headers.get('sec-fetch-site')).toBe('same-origin');
        expect(request?.url).toBe('https://engine.test/api/v1/folders?limit=2');
        expect(() => api.url(R.getAgent)).toThrow('no value for path parameter agentId');
    });

    it('fails a problem where a success or another problem was expected', async () => {
        const problem = { type: 'x', title: 'X', status: 404, code: 'not-found' };
        const headers = { 'content-type': 'application/problem+json' };
        const { api } = apiAnswering(() => new Response(JSON.stringify(problem), { status: 404, headers }));
        await expect(api.ok(R.getMe)).rejects.toThrow('expected success, got 404 not-found');
        await expect(api.problem(R.getMe, {}, 'forbidden')).rejects.toThrow('expected forbidden, got 404 not-found');
        const ok = apiAnswering(() => Response.json({ items: [], nextCursor: null })).api;
        await expect(ok.problem(R.listFolders, {}, 'forbidden')).rejects.toThrow('expected forbidden, got 200');
    });

    it('streams until told to stop, until the time is up, and refuses a body-less or non-SSE route', async () => {
        const event = (seq: number) =>
            `id: ${String(seq)}\nevent: delta\ndata: {"type":"delta","seq":${String(seq)},"text":"x"}\n\n`;
        const sse = { 'content-type': 'text/event-stream' };
        const params = { chatId: 'c', messageId: 'm' };
        const stopped = await apiAnswering(() => new Response(event(1) + event(2), { headers: sse })).api.stream(
            R.streamChatReply,
            { params, lastEventId: '0' },
            { maxMs: 1000, until: () => true },
        );
        expect(stopped.items).toHaveLength(1);
        expect(stopped.ended).toBe(false);

        const endless = new ReadableStream<Uint8Array>({
            start: (controller) => {
                controller.enqueue(new TextEncoder().encode(event(1)));
            },
        });
        const timed = await apiAnswering(() => new Response(endless, { headers: sse })).api.stream(
            R.streamChatReply,
            { params },
            { maxMs: 30 },
        );
        expect(timed.items).toHaveLength(1);
        expect(timed.ended).toBe(false);

        const empty = apiAnswering(() => new Response(null, { headers: sse })).api;
        await expect(empty.stream(R.streamChatReply, { params }, { maxMs: 1000 })).rejects.toThrow(
            'stream has no body',
        );
        await expect(empty.stream(R.getMe, {}, { maxMs: 1000 })).rejects.toThrow('is not an SSE route');
        const refused = apiAnswering(() => new Response('', { status: 302 })).api;
        await expect(refused.stream(R.streamChatReply, { params }, { maxMs: 1000 })).rejects.toThrow(CheckFailure);
    });

    it('tells the observers about every body it reads', async () => {
        const { api } = apiAnswering(
            () => new Response(JSON.stringify({ revoked: 0 }), { headers: { 'content-type': 'application/json' } }),
        );
        const seen: string[] = [];
        api.observe((route, bytes) => seen.push(`${route.id}:${String(bytes.length)}`));
        await api.withSignal(new AbortController().signal).ok(R.revokeMyOtherSessions);
        expect(seen).toEqual(['revokeMyOtherSessions:13']);
        expect(createSeededRandom(1).bytes(0)).toHaveLength(0);
    });
});
