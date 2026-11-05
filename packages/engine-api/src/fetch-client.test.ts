import { describe, expect, it, vi } from 'vitest';

import { EngineApiContractError } from './client';
import { activitySample } from './capabilities/fixtures/samples';
import { AgentId, ChatId, FileId, FileVersionId, FolderId, IntegrationId, MessageId, RunId } from './common';
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
    origin: 'content',
    visibility: 'private',
    folderId: null,
    currentRevisionId: 'r1',
    createdBy: 'm1',
    createdAt: AT,
    updatedAt: AT,
    deletedAt: null,
};

const chat = {
    id: 'c1',
    title: '',
    status: 'open',
    members: [{ kind: 'agent', key: 'a1', name: 'Ada' }],
    createdAt: AT,
    updatedAt: AT,
    messageCount: 2,
    lastMessageAt: AT,
    preview: 'Do you ship to Brno?',
    unread: 0,
    questions: [],
};

const reply = {
    type: 'message',
    id: 'c1#2',
    chatId: 'c1',
    author: { kind: 'agent', key: 'a1' },
    content: 'Hello',
    status: 'completed',
    createdBy: null,
    createdAt: AT,
    choices: [],
};

const fileMetadata = {
    id: 'f1',
    name: 'notes.txt',
    contentType: 'text/plain',
    sizeBytes: 5,
    sha256: 'a'.repeat(64),
    purpose: 'upload',
    agentId: null,
    chatId: null,
    runId: null,
    scan: { status: 'pending', checkedAt: null },
    versionCount: 1,
    createdBy: 'm1',
    createdAt: AT,
};

const engineInfo = {
    name: 'Home',
    engineId: 'abcdefghijklmnopqrstuvwxyz',
    hostname: 'abcdefghijklmnopqrstuvwxyz.ptbk.example',
    dashboardUrl: null,
    mode: 'tunnel',
    capabilities: [{ id: 'runs', version: 1 }],
};

const integration = {
    id: 'i1',
    agentId: null,
    name: 'Docs',
    kind: 'mcp-server',
    status: 'connected',
    statusDetail: null,
    scopes: [],
    secretRefs: [{ name: 'DOCS_TOKEN', secretId: null, state: 'missing' }],
    tools: [],
    lastActivityAt: null,
    createdBy: 'm1',
    createdAt: AT,
    updatedAt: AT,
    config: { url: 'https://mcp.example.com' },
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

    it('drops fields it does not know, at every depth', async () => {
        const { client } = setup(() => json({ ...agent, added: SENTINEL, profile: { ...agent.profile, mood: 'x' } }));
        expect(await client.agents.get(AgentId.parse('a1'), signal())).toEqual({ kind: 'ok', data: agent });
    });

    it.each([
        ['a wrong type', { ...agent, name: 42, profile: { ...agent.profile, description: [SENTINEL] } }],
        ['a missing field', { ...agent, name: undefined, leaked: SENTINEL }],
        ['a failed check', { ...agent, id: `bad id ${SENTINEL}` }],
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
            MessageId.parse('c1#2'),
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
        expect(calls[0]?.url).toBe(`${BASE_URL}${ENGINE_API_PREFIX}/chats/c1/messages/c1%232/stream`);
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
        const response = await client.files.upload({ file, name: 'notes.txt', purpose: 'upload' }, signal());
        expect(response).toEqual({ kind: 'ok', data: fileMetadata });
        const body = calls[0]?.init.body;
        expect(body).toBeInstanceOf(FormData);
        const form = body as FormData;
        expect(await (form.get('file') as Blob).text()).toBe('hello');
        expect(form.get('name')).toBe('notes.txt');
        expect(form.get('purpose')).toBe('upload');
        expect(form.has('agentId')).toBe(false);
        expect(new Headers(calls[0]?.init.headers).has('content-type')).toBe(false);
    });

    it('downloads binary content as a Blob, optionally one version', async () => {
        const { client, calls } = setup(
            () => new Response('hello', { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
        );
        const response = await client.files.download(FileId.parse('f1'), {}, signal());
        if (response.kind !== 'ok') throw new Error('expected a file');
        expect(response.data).toBeInstanceOf(Blob);
        expect(await response.data.text()).toBe('hello');
        await client.files.download(FileId.parse('f1'), { version: FileVersionId.parse('v2') }, signal());
        expect(calls[1]?.url).toBe(`${BASE_URL}${ENGINE_API_PREFIX}/files/f1/content?version=v2`);
    });
});

describe('tolerant reading', () => {
    it('reads a GET /engine response with fields this client does not know', async () => {
        const { client } = setup(() =>
            json({ ...engineInfo, region: 'eu', capabilities: [{ id: 'runs', version: 1, beta: true }] }),
        );
        expect(await client.engine.get(signal())).toEqual({ kind: 'ok', data: engineInfo });
    });

    it('reads a GET /engine response from an engine on API 1.0 as having no capabilities', async () => {
        const legacy: Partial<typeof engineInfo> = { ...engineInfo };
        delete legacy.capabilities;
        const { client } = setup(() => json(legacy));
        expect(await client.engine.get(signal())).toEqual({ kind: 'ok', data: { ...legacy, capabilities: [] } });
    });

    it('reads a problem with fields this client does not know', async () => {
        const conflict = createProblem('run-finished');
        const { client } = setup(() => problem({ ...conflict, retryAfter: 3 }, 409));
        expect(await client.runs.cancel(RunId.parse('r1'), signal())).toEqual({ kind: 'problem', problem: conflict });
    });

    it('reads an integration of an unknown kind without its config', async () => {
        const slack = { ...integration, id: 'i2', kind: 'slack', config: { workspace: SENTINEL } };
        const { client } = setup(() => json({ items: [integration, slack], nextCursor: null }));
        const response = await client.integrations.list({}, signal());
        if (response.kind !== 'ok') throw new Error('expected a page');
        const [known, unknown] = response.data.items;
        expect(known).toEqual(integration);
        expect(unknown).toMatchObject({ id: 'i2', kind: 'unknown', rawKind: 'slack', name: 'Docs' });
        expect(unknown).not.toHaveProperty('config');
        expect(JSON.stringify(response.data)).not.toContain(SENTINEL);
    });

    it('reads an integration status or secret state it does not know as unknown', async () => {
        const newer = {
            ...integration,
            status: 'sleeping',
            secretRefs: integration.secretRefs.map((ref) => ({ ...ref, state: 'expired' })),
        };
        const { client } = setup(() => json(newer));
        const response = await client.integrations.get(IntegrationId.parse('i1'), signal());
        if (response.kind !== 'ok') throw new Error('expected an integration');
        expect(response.data.status).toBe('unknown');
        expect(response.data.secretRefs.map(({ state }) => state)).toEqual(['unknown']);
    });

    it('reads a single integration and strips unknown config fields of a known kind', async () => {
        const { client } = setup(() => json({ ...integration, config: { ...integration.config, transport: 'sse' } }));
        expect(await client.integrations.get(IntegrationId.parse('i1'), signal())).toEqual({
            kind: 'ok',
            data: integration,
        });
    });

    it.each([
        ['a known kind with a broken field', { ...integration, name: '' }],
        ['an unknown kind with a broken common field', { ...integration, kind: 'slack', name: '' }],
        ['a kind that is not a string', { ...integration, kind: 7 }],
    ])('rejects %s', async (_, body) => {
        const { client } = setup(() => json(body));
        await expect(client.integrations.get(IntegrationId.parse('i1'), signal())).rejects.toBeInstanceOf(
            EngineApiContractError,
        );
    });

    it('reads an activity page with an unknown kind and drops items without a base', async () => {
        const known = activitySample('run.started', 'act1');
        const deploy = { ...activitySample('run.started', 'act2'), kind: 'deploy.started' };
        const { client } = setup(() => json({ items: [known, deploy, { kind: 'run.started' }], nextCursor: null }));
        const response = await client.activity.list({}, signal());
        if (response.kind !== 'ok') throw new Error('expected a page');
        expect(response.data.dropped).toBe(1);
        expect(response.data.items.map(({ kind }) => kind)).toEqual(['known', 'unknown']);
    });

    it('skips unknown event types and reads activity of an unknown kind as data', async () => {
        const activity = { ...activitySample('run.started'), kind: 'deploy.started' };
        const stream = [
            encodeSseMessage({
                event: 'agent.teleported',
                id: '1',
                data: JSON.stringify({ type: 'agent.teleported' }),
            }),
            encodeSseMessage({ event: 'activity', id: '2', data: JSON.stringify({ type: 'activity', activity }) }),
            encodeSseMessage({
                event: 'activity',
                id: '3',
                data: JSON.stringify({ type: 'activity', activity: { kind: 'x' } }),
            }),
            encodeSseMessage({
                event: 'run.changed',
                id: '4',
                data: JSON.stringify({ type: 'run.changed', runId: 'r1', agentId: 'a1', status: 'running', pct: 5 }),
            }),
        ];
        const { client } = setup(() => sseResponse([stream.join('')]));
        const response = await client.events.stream({}, signal());
        if (response.kind !== 'ok') throw new Error('expected a stream');
        const items = await collect(response.data);
        expect(items.map(({ id }) => id)).toEqual(['2', '4']);
        expect(items[0]?.event).toMatchObject({ type: 'activity', activity: { kind: 'unknown' } });
        expect(items[1]?.event).toEqual({ type: 'run.changed', runId: 'r1', agentId: 'a1', status: 'running' });
    });

    it('reads a message status this client does not know as unknown, in entries and in a send result', async () => {
        const later = { ...reply, status: 'queued', extra: true };
        const { client } = setup((call) =>
            call.url.endsWith('/entries')
                ? json({ items: [later, { type: 'task-card', id: 'x' }], nextCursor: null })
                : json({ message: later }, 202),
        );
        const entries = await client.chats.listEntries(ChatId.parse('c1'), {}, signal());
        if (entries.kind !== 'ok') throw new Error('expected a page');
        expect(entries.data.items).toEqual([{ ...reply, status: 'unknown' }]);
        const sent = await client.chats.sendMessage(ChatId.parse('c1'), { content: 'Hi' }, signal());
        expect(sent).toMatchObject({ kind: 'ok', data: { message: { ...reply, status: 'unknown' } } });
    });

    it('reads a thread status this client does not know as unknown, in pages and single chats', async () => {
        const later = { ...chat, id: 'c2', status: 'archived', pinned: true };
        const { client } = setup((call) =>
            call.url.endsWith('/chats/c2') ? json(later) : json({ items: [chat, later], nextCursor: null }),
        );
        const page = await client.chats.list(AgentId.parse('a1'), {}, signal());
        if (page.kind !== 'ok') throw new Error('expected a page');
        expect(page.data.items).toEqual([chat, { ...chat, id: 'c2', status: 'unknown' }]);
        expect(await client.chats.get(ChatId.parse('c2'), signal())).toEqual({
            kind: 'ok',
            data: { ...chat, id: 'c2', status: 'unknown' },
        });
    });

    it.each([
        ['a status that is not a string', { ...chat, status: 7 }],
        ['a broken known field next to an unknown status', { ...chat, status: 'archived', messageCount: -1 }],
    ])('rejects a chat with %s', async (_, body) => {
        const { client } = setup(() => json(body));
        await expect(client.chats.get(ChatId.parse('c1'), signal())).rejects.toBeInstanceOf(EngineApiContractError);
    });

    it('reads a security overview from a newer engine with unknown values as unknown and extra fields dropped', async () => {
        const sha = 'a'.repeat(64);
        const overview = {
            engine: { version: '1.4.0', releaseLogIndex: 7, releaseLogEntryUuid: null },
            update: { status: 'none', policy: 'auto', pinnedVersion: null, availableVersion: null, eligibleAt: null },
            ui: {
                version: '1.4.0',
                bundleSha256: sha,
                releaseLogIndex: null,
                releaseLogEntryUuid: null,
                lastUpdateCheck: { at: AT, outcome: 'deferred', version: null, reason: null, revocationReason: null },
            },
            tls: { certificateSha256: sha, notAfter: AT, lastCtCheck: null, pinned: true },
            relays: [],
            hostnames: [
                { hostname: 'e.ptbk.io', kind: 'default', certificateStatus: 'revoked', claimRegistered: null },
            ],
            lastHeartbeat: null,
            clockSkew: null,
            outboundDestinations: [],
        };
        const { client } = setup(() => json(overview));
        const response = await client.security.get(signal());
        if (response.kind !== 'ok') throw new Error('expected the overview');
        expect(response.data.ui.lastUpdateCheck?.outcome).toBe('unknown');
        expect(response.data.hostnames[0]?.certificateStatus).toBe('unknown');
        expect(response.data.tls).not.toHaveProperty('pinned');
    });

    it('reads a run status or source a newer engine added as unknown, so the page still loads', async () => {
        const run = {
            id: 'run_1',
            agentId: 'agt_1',
            agentName: 'Ada',
            source: 'kiosk',
            status: 'paused',
            chatId: null,
            messageId: null,
            triggerId: null,
            retryOf: null,
            taskId: null,
            occurrenceId: null,
            createdBy: null,
            queuedAt: AT,
            startedAt: null,
            completedAt: null,
            cancelRequestedAt: null,
            attemptCount: 0,
            runner: null,
            model: null,
            progress: null,
            usage: null,
            error: null,
            preview: null,
            priority: 3,
        };
        const { client } = setup(() => json({ items: [run], nextCursor: null }));
        const response = await client.runs.list({}, signal());
        if (response.kind !== 'ok') throw new Error('expected a page');
        expect(response.data.items[0]).toMatchObject({ status: 'unknown', source: 'unknown', agentName: 'Ada' });
        expect(response.data.items[0]).not.toHaveProperty('priority');
    });

    it('reads an audit action a newer engine added as its raw name, so the page still loads', async () => {
        const entry = {
            id: 'aud_1',
            seq: 1,
            at: AT,
            actor: { kind: 'system' },
            action: 'agent.clone',
            target: { kind: 'agent', id: 'a1', name: 'Ada', label: 'x' },
            outcome: 'success',
            client: null,
            details: { from: 'a0' },
            hash: 'a'.repeat(64),
            prevHash: null,
        };
        const { client } = setup(() => json({ items: [entry], nextCursor: null }));
        const response = await client.audit.list({}, signal());
        if (response.kind !== 'ok') throw new Error('expected a page');
        expect(response.data.items[0]?.action).toBe('agent.clone');
        expect(response.data.items[0]?.target).toEqual({ kind: 'agent', id: 'a1', name: 'Ada' });
        expect(response.data.items[0]?.details).toEqual({ from: 'a0' });
    });

    it('drops a value a misbehaving engine sends with secret metadata, so it never reaches the caller', async () => {
        const metadata = {
            id: 's1',
            name: 'GITHUB_TOKEN',
            scope: { kind: 'engine' },
            status: 'active',
            createdBy: 'm1',
            createdAt: AT,
            updatedAt: AT,
            valueUpdatedAt: AT,
            lastUsedAt: null,
        };
        const { client } = setup(() => json({ items: [{ ...metadata, value: SENTINEL }], nextCursor: null }));
        const response = await client.secrets.list({}, signal());
        expect(response).toEqual({ kind: 'ok', data: { items: [metadata], nextCursor: null } });
        expect(JSON.stringify(response)).not.toContain(SENTINEL);
    });

    it('fails the stream on an event without a type', async () => {
        const body = encodeSseMessage({ event: 'message', data: JSON.stringify({ agentId: 'a1' }) });
        const { client } = setup(() => sseResponse([body]));
        const response = await client.events.stream({}, signal());
        if (response.kind !== 'ok') throw new Error('expected a stream');
        await expect(collect(response.data)).rejects.toBeInstanceOf(EngineApiContractError);
    });
});
