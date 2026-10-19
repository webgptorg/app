import { describe, expect, it, vi } from 'vitest';

import { EngineApiContractError } from './client';
import { AgentId, ChatId, FileId, FolderId, MessageId } from './common';
import { ENGINE_API_PREFIX } from './constants';
import { createFetchEngineApiClient } from './fetch-client';
import { createProblem } from './problem';
import { encodeSseMessage } from './sse';

const BASE_URL = 'https://engine.example';
const AT = '2026-10-19T12:00:00Z';
const SENTINEL = 'SENSITIVE-CONTENT-7f3a';

const agent = {
    id: 'a1',
    permanentId: 'p1',
    name: 'Ada',
    profile: { fullname: 'Ada', description: '', avatarUrl: null, color: null, initialMessage: null },
    visibility: 'private',
    folderId: null,
    currentRevisionId: 'r1',
    createdBy: 'm1',
    createdAt: AT,
    updatedAt: AT,
    deletedAt: null,
};

const reply = {
    id: 'msg2',
    chatId: 'c1',
    role: 'agent',
    content: 'Hello',
    status: 'completed',
    createdBy: null,
    createdAt: AT,
};

const fileMetadata = {
    id: 'f1',
    name: 'notes.txt',
    contentType: 'text/plain',
    sizeBytes: 5,
    sha256: 'a'.repeat(64),
    createdBy: 'm1',
    createdAt: AT,
};

interface Call {
    readonly url: string;
    readonly init: RequestInit;
}

type Responder = (call: Call) => Response | Promise<Response>;

function setup(responder: Responder, timeoutMs = 1_000) {
    const calls: Call[] = [];
    const fetchFake = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const call = { url: input instanceof Request ? input.url : String(input), init: init ?? {} };
        calls.push(call);
        return Promise.resolve(responder(call));
    });
    const client = createFetchEngineApiClient({ baseUrl: BASE_URL, fetch: fetchFake, timeoutMs });
    return { client, calls, fetchFake };
}

function json(body: unknown, status = 200, contentType = 'application/json'): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } });
}

function problem(body: unknown, status: number): Response {
    return json(body, status, 'application/problem+json');
}

function waitForAbort(call: Call): Promise<Response> {
    return new Promise((_, reject) => {
        const signal = call.init.signal;
        if (!signal) throw new Error('fetch was called without a signal');
        signal.addEventListener('abort', () => {
            reject(signal.reason as Error);
        });
    });
}

function sseResponse(chunks: readonly string[], delayMs = 0): Response {
    const encoder = new TextEncoder();
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
            const chunk = chunks[index++];
            if (chunk === undefined) controller.close();
            else controller.enqueue(encoder.encode(chunk));
        },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
    const result: T[] = [];
    for await (const item of items) result.push(item);
    return result;
}

const signal = (): AbortSignal => new AbortController().signal;

describe('createFetchEngineApiClient', () => {
    it('sends a same-origin request and returns validated data', async () => {
        const { client, calls } = setup(() => json(agent));
        const response = await client.agents.get(AgentId.parse('a1'), signal());
        expect(response).toEqual({ kind: 'ok', data: agent });
        expect(calls).toHaveLength(1);
        const [call] = calls;
        expect(call?.url).toBe(`${BASE_URL}${ENGINE_API_PREFIX}/agents/a1`);
        expect(call?.init.method).toBe('GET');
        expect(call?.init.credentials).toBe('same-origin');
        expect(call?.init.body).toBeNull();
    });

    it('encodes path parameters and serialises the query, skipping undefined values', async () => {
        const { client, calls } = setup(() => json({ items: [agent], nextCursor: null }));
        await client.agents.list({ q: 'a b', folderId: undefined, limit: 10 }, signal());
        await client.agents.getSource('a/b' as AgentId, signal()).catch(() => undefined);
        expect(calls[0]?.url).toBe(`${BASE_URL}${ENGINE_API_PREFIX}/agents?q=a+b&limit=10`);
        expect(calls[1]?.url).toBe(`${BASE_URL}${ENGINE_API_PREFIX}/agents/a%2Fb/source`);
    });

    it('sends JSON bodies with a JSON content type', async () => {
        const { client, calls } = setup(() => json(agent, 201));
        const response = await client.agents.create({ source: 'Ada\nPERSONA helpful' }, signal());
        expect(response.kind).toBe('ok');
        const headers = new Headers(calls[0]?.init.headers);
        expect(calls[0]?.init.method).toBe('POST');
        expect(headers.get('content-type')).toBe('application/json');
        expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ source: 'Ada\nPERSONA helpful' });
    });

    it('returns null data for 204', async () => {
        const { client, calls } = setup(() => new Response(null, { status: 204 }));
        const response = await client.folders.delete(FolderId.parse('f1'), signal());
        expect(response).toEqual({ kind: 'ok', data: null });
        expect(calls[0]?.init.method).toBe('DELETE');
    });

    it('resolves problem+json as a problem', async () => {
        const forbidden = createProblem('forbidden', { requiredPermission: 'agents.delete' });
        const { client } = setup(() => problem(forbidden, 403));
        const response = await client.agents.delete(AgentId.parse('a1'), signal());
        expect(response).toEqual({ kind: 'problem', problem: forbidden });
        if (response.kind === 'problem') expect(response.problem.requiredPermission).toBe('agents.delete');
    });

    it.each([
        ['an unknown field', { ...agent, leaked: SENTINEL }],
        ['a wrong type', { ...agent, name: 42, profile: { ...agent.profile, description: [SENTINEL] } }],
    ])('rejects a response with %s without echoing its content', async (_, body) => {
        const { client } = setup(() => json(body));
        const error = await client.agents.get(AgentId.parse('a1'), signal()).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(EngineApiContractError);
        expect((error as EngineApiContractError).routeId).toBe('getAgent');
        expect((error as Error).message).not.toContain(SENTINEL);
    });

    it('rejects a problem sent with the wrong content type', async () => {
        const { client } = setup(() => json(createProblem('forbidden'), 403));
        await expect(client.agents.get(AgentId.parse('a1'), signal())).rejects.toBeInstanceOf(EngineApiContractError);
    });

    it('rejects a problem whose status differs from the HTTP status', async () => {
        const { client } = setup(() => problem(createProblem('forbidden'), 404));
        await expect(client.agents.get(AgentId.parse('a1'), signal())).rejects.toBeInstanceOf(EngineApiContractError);
    });

    it('rejects an unexpected status without problem+json', async () => {
        const { client } = setup(
            () => new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
        );
        await expect(client.agents.get(AgentId.parse('a1'), signal())).rejects.toBeInstanceOf(EngineApiContractError);
    });

    it('rejects a body that is not JSON', async () => {
        const { client } = setup(
            () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
        );
        await expect(client.agents.get(AgentId.parse('a1'), signal())).rejects.toBeInstanceOf(EngineApiContractError);
    });

    it('propagates network failures', async () => {
        const { client } = setup(() => {
            throw new TypeError('Failed to fetch');
        });
        await expect(client.me.get(signal())).rejects.toThrow(TypeError);
    });

    it('times out with a TimeoutError', async () => {
        const { client, calls } = setup(waitForAbort, 10);
        const error = await client.me.get(signal()).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).name).toBe('TimeoutError');
        expect(calls[0]?.init.signal?.aborted).toBe(true);
    });

    it('rejects with the abort reason when the caller aborts', async () => {
        const { client, calls } = setup(waitForAbort);
        const controller = new AbortController();
        const pending = client.me.get(controller.signal);
        controller.abort();
        const error = await pending.catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).name).toBe('AbortError');
        expect(calls[0]?.init.signal?.aborted).toBe(true);
    });

    it('does not call fetch with an already aborted signal', async () => {
        const { client, fetchFake } = setup(() => json(agent));
        await expect(client.me.get(AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
        expect(fetchFake).not.toHaveBeenCalled();
    });

    it('streams SSE events with their ids and sends Last-Event-ID', async () => {
        const stream = [
            encodeSseMessage({ event: 'delta', id: '4', data: JSON.stringify({ type: 'delta', seq: 4, text: 'Hel' }) }),
            ': keep-alive\n\n',
            encodeSseMessage({ event: 'delta', id: '5', data: JSON.stringify({ type: 'delta', seq: 5, text: 'lo' }) }),
            encodeSseMessage({ event: 'completed', data: JSON.stringify({ type: 'completed', message: reply }) }),
        ];
        const { client, calls } = setup(() => sseResponse([stream.join('')]));
        const response = await client.chats.streamReply(
            ChatId.parse('c1'),
            MessageId.parse('msg2'),
            { lastEventId: '3' },
            signal(),
        );
        if (response.kind !== 'ok') throw new Error('expected a stream');
        expect(await collect(response.data)).toEqual([
            { id: '4', event: { type: 'delta', seq: 4, text: 'Hel' } },
            { id: '5', event: { type: 'delta', seq: 5, text: 'lo' } },
            { id: '5', event: { type: 'completed', message: reply } },
        ]);
        const headers = new Headers(calls[0]?.init.headers);
        expect(calls[0]?.url).toBe(`${BASE_URL}${ENGINE_API_PREFIX}/chats/c1/messages/msg2/stream`);
        expect(headers.get('last-event-id')).toBe('3');
        expect(headers.get('accept')).toContain('text/event-stream');
    });

    it('fails the stream when the SSE event name differs from the event type', async () => {
        const body = encodeSseMessage({
            event: 'completed',
            data: JSON.stringify({ type: 'delta', seq: 1, text: 'x' }),
        });
        const { client } = setup(() => sseResponse([body]));
        const response = await client.chats.streamReply(ChatId.parse('c1'), MessageId.parse('msg2'), {}, signal());
        if (response.kind !== 'ok') throw new Error('expected a stream');
        await expect(collect(response.data)).rejects.toBeInstanceOf(EngineApiContractError);
    });

    it('fails the stream on an event that does not match the schema', async () => {
        const body = encodeSseMessage({ event: 'agent.changed', data: JSON.stringify({ type: 'agent.changed' }) });
        const { client } = setup(() => sseResponse([body]));
        const response = await client.events.stream({}, signal());
        if (response.kind !== 'ok') throw new Error('expected a stream');
        await expect(collect(response.data)).rejects.toBeInstanceOf(EngineApiContractError);
    });

    it('does not apply the timeout to a stream that has started', async () => {
        const event = (n: number) =>
            encodeSseMessage({
                event: 'agent.changed',
                id: String(n),
                data: JSON.stringify({ type: 'agent.changed', agentId: `a${String(n)}` }),
            });
        const { client } = setup(() => sseResponse([event(1), event(2), event(3)], 15), 10);
        const response = await client.events.stream({}, signal());
        if (response.kind !== 'ok') throw new Error('expected a stream');
        const items = await collect(response.data);
        expect(items.map((item) => item.id)).toEqual(['1', '2', '3']);
    });

    it('stops a stream when the caller aborts', async () => {
        const event = encodeSseMessage({
            event: 'agent.changed',
            data: JSON.stringify({ type: 'agent.changed', agentId: 'a1' }),
        });
        const { client } = setup(() => sseResponse([event, event, event], 5));
        const controller = new AbortController();
        const response = await client.events.stream({}, controller.signal);
        if (response.kind !== 'ok') throw new Error('expected a stream');
        const seen: unknown[] = [];
        const error = await (async () => {
            for await (const item of response.data) {
                seen.push(item);
                controller.abort();
            }
        })().catch((e: unknown) => e);
        expect(seen).toHaveLength(1);
        expect(error).toMatchObject({ name: 'AbortError' });
    });

    it('uploads multipart form data with a file and a name', async () => {
        const { client, calls } = setup(() => json(fileMetadata, 201));
        const file = new Blob(['hello'], { type: 'text/plain' });
        const response = await client.files.upload({ file, name: 'notes.txt' }, signal());
        expect(response).toEqual({ kind: 'ok', data: fileMetadata });
        const body = calls[0]?.init.body;
        expect(body).toBeInstanceOf(FormData);
        const form = body as FormData;
        expect(await (form.get('file') as Blob).text()).toBe('hello');
        expect(form.get('name')).toBe('notes.txt');
        expect(new Headers(calls[0]?.init.headers).has('content-type')).toBe(false);
    });

    it('downloads binary content as a Blob', async () => {
        const { client } = setup(
            () => new Response('hello', { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
        );
        const response = await client.files.download(FileId.parse('f1'), signal());
        if (response.kind !== 'ok') throw new Error('expected a file');
        expect(response.data).toBeInstanceOf(Blob);
        expect(await response.data.text()).toBe('hello');
    });
});
