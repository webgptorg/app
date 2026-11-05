/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument --
   The edits below rewrite arbitrary JSON answers; typing every shape would hide what each case breaks. */
import { describe, expect, it } from 'vitest';

import type { CheckOutcome } from '../../check';
import { runConformance } from '../../runner';
import type { ConformanceTarget } from '../../target';
import type { FakeEngineOptions, Tamper } from '../../testing/fake-engine';
import { createFakeEngine } from '../../testing/fake-engine';
import { ENGINE_API_SUITE } from './index';

type Match = (request: Request) => boolean;

function without<T extends object>(data: T, key: keyof T): T {
    return Object.fromEntries(Object.entries(data).filter(([name]) => name !== key)) as T;
}

const on =
    (method: string, pattern: RegExp, also: (request: Request) => boolean = () => true): Match =>
    (request) =>
        request.method === method &&
        pattern.test(new URL(request.url).pathname.slice('/api/v1'.length)) &&
        also(request);

const query = (name: string, value?: string) => (request: Request) => {
    const found = new URL(request.url).searchParams.get(name);
    return value === undefined ? found !== null : found === value;
};

function editJson(match: Match, edit: (data: any, request: Request) => unknown): Tamper {
    return async (request, response) => {
        if (!match(request) || response.headers.get('content-type') !== 'application/json') return response;
        const data = await response.json();
        return new Response(JSON.stringify(edit(data, request)), {
            status: response.status,
            headers: response.headers,
        });
    };
}

/** A page request outside the engine API whose path starts with `prefix`. */
const page =
    (prefix: string): Match =>
    (request) =>
        request.method === 'GET' && new URL(request.url).pathname.startsWith(prefix);

const redirectTo = (location: string) => new Response(null, { status: 303, headers: { location } });

function replace(match: Match, make: (request: Request, response: Response) => Response | Promise<Response>): Tamper {
    return (request, response) => (match(request) ? make(request, response) : response);
}

/** Applies each edit only from its `nth` matching call on (1-based). */
function fromCall(nth: number, tamper: Tamper, match: Match): Tamper {
    let calls = 0;
    return (request, response) => (match(request) && ++calls >= nth ? tamper(request, response) : response);
}

/** Answers every matching call with the body of the first one, as if nothing had changed. */
function firstAnswerAgain(match: Match): Tamper {
    let first: string | undefined;
    return async (request, response) => {
        if (!match(request)) return response;
        first ??= await response.text();
        return new Response(first, { status: 200, headers: { 'content-type': 'application/json' } });
    };
}

function chain(...tampers: Tamper[]): Tamper {
    return async (request, response) => {
        let current = response;
        for (const tamper of tampers) current = await tamper(request, current);
        return current;
    };
}

function problem(code: string, status: number, extra: Record<string, unknown> = {}): Response {
    return new Response(JSON.stringify({ type: 'https://ptbk.io/problems/x', title: 'X', status, code, ...extra }), {
        status,
        headers: { 'content-type': 'application/problem+json' },
    });
}

function sse(events: readonly { readonly event: string; readonly data: string; readonly id?: string }[]): Response {
    const text = events.map(
        ({ event, data, id }) => `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${data}\n\n`,
    );
    return new Response(text.join(''), { headers: { 'content-type': 'text/event-stream' } });
}

const delta = (seq: number) => ({
    event: 'delta',
    id: String(seq),
    data: JSON.stringify({ type: 'delta', seq, text: 'x' }),
});

/** The completed event the fake would send, re-encoded with an edit. */
async function editReply(response: Response, edit: (events: any[]) => any[]): Promise<Response> {
    const events = (await response.text())
        .split('\n\n')
        .filter((block) => block.includes('data: '))
        .map((block) => JSON.parse(block.slice(block.indexOf('data: ') + 6)));
    return sse(
        edit(events).map((event) => ({
            event: event.type,
            data: JSON.stringify(event),
            ...(event.type === 'delta' ? { id: String(event.seq) } : {}),
        })),
    );
}

const STREAM = /^\/chats\/[^/]+\/messages\/[^/]+\/stream$/;

async function outcome(
    id: string,
    options: FakeEngineOptions,
    adjust: (target: ConformanceTarget) => ConformanceTarget = (target) => target,
): Promise<CheckOutcome> {
    const { target } = await createFakeEngine(options);
    const report = await runConformance({
        target: adjust(target),
        suites: [ENGINE_API_SUITE],
        filter: (check) => check.id === id,
        timeoutMs: 20_000,
        signal: AbortSignal.timeout(60_000),
        seed: 11,
    });
    return report.results[0]?.outcome ?? { kind: 'fail', detail: 'not run' };
}

type Case = readonly [
    name: string,
    id: string,
    options: FakeEngineOptions,
    adjust?: (target: ConformanceTarget) => ConformanceTarget,
];

const FAILS: readonly Case[] = [
    [
        'engine info without engineId',
        'engine-api.engine.info',
        { tamper: editJson(on('GET', /^\/engine$/), (data) => without(data, 'engineId')) },
    ],
    [
        'engine info without capabilities',
        'engine-api.engine.info',
        { tamper: editJson(on('GET', /^\/engine$/), (data) => without(data, 'capabilities')) },
    ],
    [
        'engine info for another hostname',
        'engine-api.engine.info',
        { tamper: editJson(on('GET', /^\/engine$/), (data) => ({ ...data, hostname: 'other.engine.test' })) },
    ],
    [
        'engine info as a problem',
        'engine-api.engine.info',
        { tamper: replace(on('GET', /^\/engine$/), () => problem('unavailable', 503)) },
    ],
    [
        'an engine ID from another key',
        'engine-api.engine.id-matches-key',
        { tamper: editJson(on('GET', /^\/engine$/), (data) => ({ ...data, engineId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa' })) },
    ],
    [
        'an unadvertised route answering not-found',
        'engine-api.capabilities.unadvertised-404',
        { capabilities: [], tamper: replace(on('GET', /^\/runs$/), () => problem('not-found', 404)) },
    ],
    [
        'a heartbeat body that is not JSON',
        'engine-api.security.heartbeat-body',
        {
            tamper: editJson(on('GET', /^\/security$/), (data) => ({
                ...data,
                lastHeartbeat: { ...data.lastHeartbeat, body: 'x' },
            })),
        },
    ],
    [
        'a heartbeat body that is not a heartbeat',
        'engine-api.security.heartbeat-body',
        {
            tamper: editJson(on('GET', /^\/security$/), (data) => ({
                ...data,
                lastHeartbeat: { ...data.lastHeartbeat, body: '{}' },
            })),
        },
    ],
    [
        'a heartbeat for another engine',
        'engine-api.security.heartbeat-body',
        {
            tamper: editJson(on('GET', /^\/security$/), (data) => ({
                ...data,
                lastHeartbeat: {
                    ...data.lastHeartbeat,
                    body: JSON.stringify({
                        ...JSON.parse(data.lastHeartbeat.body),
                        engineId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
                    }),
                },
            })),
        },
    ],
    [
        'a 401 with another code',
        'engine-api.auth.unauthenticated-401',
        {
            tamper: replace(
                (request) => !request.headers.has('cookie'),
                () => problem('forbidden', 403),
            ),
        },
    ],
    [
        'a read route failing',
        'engine-api.schemas.responses-strict',
        { tamper: replace(on('GET', /^\/folders$/), () => problem('internal-error', 500)) },
    ],
    [
        'JSON sent as text',
        'engine-api.schemas.responses-strict',
        {
            tamper: replace(
                on('GET', /^\/folders$/),
                async (_, response) =>
                    new Response(await response.text(), { headers: { 'content-type': 'text/plain' } }),
            ),
        },
    ],
    [
        'a body that is not JSON',
        'engine-api.schemas.responses-strict',
        {
            tamper: replace(
                on('GET', /^\/folders$/),
                () => new Response('{', { headers: { 'content-type': 'application/json' } }),
            ),
        },
    ],
    [
        'events without the SSE content type',
        'engine-api.schemas.responses-strict',
        {
            tamper: replace(
                on('GET', /^\/events$/),
                () => new Response('', { headers: { 'content-type': 'text/plain' } }),
            ),
        },
    ],
    [
        'an event stream refused',
        'engine-api.schemas.responses-strict',
        { tamper: replace(on('GET', /^\/events$/), () => problem('unavailable', 503)) },
    ],
    [
        'a stream event breaking its schema',
        'engine-api.schemas.responses-strict',
        { tamper: replace(on('GET', STREAM), () => sse([{ event: 'delta', data: '{"type":"delta"}' }])) },
    ],
    [
        'a stream event that is not JSON',
        'engine-api.schemas.responses-strict',
        { tamper: replace(on('GET', STREAM), () => sse([{ event: 'delta', data: 'nope' }])) },
    ],
    [
        'a stream event under another name',
        'engine-api.schemas.responses-strict',
        { tamper: replace(on('GET', STREAM), () => sse([{ ...delta(1), event: 'other' }])) },
    ],
    [
        'a download without nosniff',
        'engine-api.schemas.responses-strict',
        {
            tamper: replace(
                on('GET', /\/content$/),
                async (_, response) =>
                    new Response(await response.blob(), { headers: { 'content-disposition': 'attachment' } }),
            ),
        },
    ],
    [
        'a download shown inline',
        'engine-api.schemas.responses-strict',
        {
            tamper: replace(
                on('GET', /\/content$/),
                async (_, response) =>
                    new Response(await response.blob(), { headers: { 'x-content-type-options': 'nosniff' } }),
            ),
        },
    ],
    [
        'a redirect instead of an answer',
        'engine-api.schemas.problems',
        {
            tamper: replace(
                on('GET', /^\/agents\/conformance-nonexistent$/),
                () => new Response(null, { status: 302, headers: { location: '/' } }),
            ),
        },
    ],
    [
        'a problem with another code',
        'engine-api.schemas.problems',
        { tamper: replace(on('GET', /^\/agents\/conformance-nonexistent$/), () => problem('validation-failed', 400)) },
    ],
    [
        'a problem whose status disagrees',
        'engine-api.schemas.problems',
        {
            tamper: replace(
                on('GET', /^\/agents\/conformance-nonexistent$/),
                async (_, response) => new Response(await response.text(), { status: 410, headers: response.headers }),
            ),
        },
    ],
    [
        'a problem with a code of another status',
        'engine-api.schemas.problems',
        { tamper: replace(on('GET', /^\/agents\/conformance-nonexistent$/), () => problem('not-found', 400)) },
    ],
    [
        'a problem with an undeclared field',
        'engine-api.schemas.problems',
        {
            tamper: replace(on('GET', /^\/agents\/conformance-nonexistent$/), () =>
                problem('not-found', 404, { stack: 'x' }),
            ),
        },
    ],
    [
        'invalid-book without diagnostics',
        'engine-api.schemas.problems',
        {
            tamper: replace(on('POST', /^\/agents$/), (_, response) =>
                response.status === 422 ? problem('invalid-book', 422) : response,
            ),
        },
    ],
    [
        'a success for a query it should refuse',
        'engine-api.input.limit-too-large',
        {
            tamper: replace(on('GET', /^\/folders$/, query('limit', '101')), () =>
                Response.json({ items: [], nextCursor: null }),
            ),
        },
    ],
    [
        'the wrong refusal code',
        'engine-api.input.garbage-cursor',
        { tamper: replace(on('GET', /^\/folders$/, query('cursor')), () => problem('validation-failed', 400)) },
    ],
    [
        'a listing that leaves items out',
        'engine-api.pagination.walk',
        { tamper: editJson(on('GET', /^\/secrets$/), (page) => ({ ...page, items: [] })) },
    ],
    [
        'a listing that never ends',
        'engine-api.pagination.walk',
        { tamper: editJson(on('GET', /^\/folders$/), (page) => ({ ...page, nextCursor: page.nextCursor ?? 'again' })) },
    ],
    [
        'a new agent already deleted',
        'engine-api.agents.create-and-list',
        { tamper: editJson(on('POST', /^\/agents$/), (agent) => ({ ...agent, deletedAt: agent.createdAt })) },
    ],
    [
        'a new agent never listed',
        'engine-api.agents.create-and-list',
        { tamper: editJson(on('GET', /^\/agents$/), (page) => ({ ...page, items: [] })) },
    ],
    [
        'a source from another revision',
        'engine-api.agents.create-and-list',
        {
            tamper: editJson(on('GET', /\/source$/), (source) => ({
                ...source,
                revisionId: 'revision-other',
                source: 'x',
            })),
        },
    ],
    [
        'an edit that keeps its revision',
        'engine-api.agents.revision-conflict',
        { tamper: editJson(on('PUT', /\/source$/), (source, request) => ({ ...source, revisionId: request.url })) },
    ],
    [
        'a refused edit that changed the source',
        'engine-api.agents.revision-conflict',
        {
            tamper: fromCall(
                2,
                editJson(on('GET', /\/source$/), (source) => ({ ...source, source: 'x' })),
                on('GET', /\/source$/),
            ),
        },
    ],
    [
        'a stale edit accepted',
        'engine-api.agents.revision-conflict',
        {
            tamper: replace(on('PUT', /\/source$/), (_, response) =>
                response.status === 409 ? problem('validation-failed', 400) : response,
            ),
        },
    ],
    [
        'a delete that keeps the agent',
        'engine-api.agents.delete-restore',
        { tamper: editJson(on('DELETE', /^\/agents\/[^/]+$/), (agent) => ({ ...agent, deletedAt: null })) },
    ],
    [
        'a deleted agent missing from deleted=only',
        'engine-api.agents.delete-restore',
        { tamper: editJson(on('GET', /^\/agents$/, query('deleted', 'only')), (page) => ({ ...page, items: [] })) },
    ],
    [
        'a restore that keeps it deleted',
        'engine-api.agents.delete-restore',
        {
            tamper: chain(
                editJson(on('POST', /\/restore$/), (agent) => ({ ...agent, deletedAt: agent.updatedAt })),
                editJson(on('GET', /^\/agents$/), (page) => ({ ...page, items: [] })),
            ),
        },
    ],
    [
        'a broken book without errors',
        'engine-api.agents.validate-diagnostics',
        { tamper: editJson(on('POST', /^\/agents\/validate$/), () => []) },
    ],
    [
        'a valid book with errors',
        'engine-api.agents.validate-diagnostics',
        {
            tamper: editJson(on('POST', /^\/agents\/validate$/), () => [
                {
                    severity: 'error',
                    code: 'x',
                    message: 'x',
                    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
                },
            ]),
        },
    ],
    [
        'a user message that is not the one sent',
        'engine-api.chat.reply-stream',
        {
            tamper: editJson(on('POST', /\/messages$/), (sent) => ({
                ...sent,
                userMessage: { ...sent.userMessage, content: 'other' },
            })),
        },
    ],
    [
        'a reply that fails',
        'engine-api.chat.reply-stream',
        {
            tamper: replace(on('GET', STREAM), (_, response) =>
                editReply(response, (events) => [
                    ...events.slice(0, -1),
                    { type: 'failed', problem: { type: 'x', title: 'X', status: 502, code: 'reply-failed' } },
                ]),
            ),
        },
    ],
    [
        'a reply completing another message',
        'engine-api.chat.reply-stream',
        {
            tamper: replace(on('GET', STREAM), (_, response) =>
                editReply(response, (events) =>
                    events.map((event) =>
                        event.type === 'completed'
                            ? {
                                  ...event,
                                  message: { ...event.message, id: 'message-other', role: 'user', status: 'streaming' },
                              }
                            : event,
                    ),
                ),
            ),
        },
    ],
    [
        'a reply never stored',
        'engine-api.chat.reply-stream',
        { tamper: editJson(on('GET', /\/entries$/), (page) => ({ ...page, items: [] })) },
    ],
    [
        'a stored reply that differs',
        'engine-api.chat.reply-stream',
        {
            tamper: editJson(on('GET', /\/entries$/), (page) => ({
                ...page,
                items: page.items.map((entry: any) =>
                    entry.type === 'message' ? { ...entry, content: 'other' } : entry,
                ),
            })),
        },
    ],
    [
        'a new thread that does not list the User first',
        'engine-api.chat.thread-joins',
        {
            tamper: editJson(on('POST', /^\/chats$/), (chat) => ({
                ...chat,
                members: [...chat.members].reverse(),
                status: 'resolved',
            })),
        },
    ],
    [
        'an author who writes before joining',
        'engine-api.chat.thread-joins',
        {
            tamper: editJson(on('GET', /\/entries$/), (page) => ({
                ...page,
                items: page.items.filter((entry: any) => entry.type !== 'joined'),
            })),
        },
    ],
    [
        'a sent message credited to nobody',
        'engine-api.chat.authorship',
        {
            tamper: editJson(on('POST', /\/messages$/), (sent) => ({
                ...sent,
                message: { ...sent.message, createdBy: null },
            })),
        },
    ],
    [
        'a reply by an agent outside the thread',
        'engine-api.chat.authorship',
        {
            tamper: editJson(on('GET', /^\/chats\/[^/]+$/), (chat) => ({
                ...chat,
                members: chat.members.filter((member: any) => member.kind !== 'agent'),
            })),
        },
    ],
    [
        'a repeated request key that saves another message',
        'engine-api.chat.idempotent-send',
        {
            tamper: fromCall(
                2,
                editJson(on('POST', /\/messages$/), (sent) => ({
                    ...sent,
                    message: { ...sent.message, id: `${String(sent.message.id)}-again` },
                })),
                on('POST', /\/messages$/),
            ),
        },
    ],
    [
        'a reused request key that is not refused',
        'engine-api.chat.idempotent-send',
        {
            tamper: replace(on('POST', /\/messages$/), (_, response) =>
                response.status === 409 ? problem('rate-limited', 429) : response,
            ),
        },
    ],
    [
        'a thread still unread after marking it read',
        'engine-api.chat.read-and-seen',
        { tamper: editJson(on('POST', /\/read$/), (chat) => ({ ...chat, unread: 3 })) },
    ],
    [
        'seeing that answers a question',
        'engine-api.chat.read-and-seen',
        {
            tamper: fromCall(
                2,
                editJson(on('POST', /\/seen$/), (chat) => ({
                    ...chat,
                    status: 'resolved',
                    questions: [
                        ...chat.questions,
                        {
                            id: 'ping',
                            messageId: `${String(chat.id)}#1`,
                            author: { kind: 'agent', key: 'agent-x' },
                            seen: false,
                        },
                    ],
                })),
                on('POST', /\/seen$/),
            ),
        },
    ],
    [
        'a thread without an agent started with another one',
        'engine-api.chat.default-chatter',
        {
            tamper: editJson(on('POST', /^\/chats$/), (chat) => ({
                ...chat,
                members: chat.members.map((member: any) =>
                    member.kind === 'agent' ? { ...member, name: 'Ada' } : member,
                ),
            })),
        },
    ],
    [
        'Chatter missing refused with another problem',
        'engine-api.chat.default-chatter',
        { tamper: replace(on('POST', /^\/chats$/), () => problem('agent-deleted', 409)) },
    ],
    [
        'deltas out of order and without ids',
        'engine-api.chat.reply-stream',
        {
            tamper: replace(on('GET', STREAM), (_, response) =>
                editReply(response, (events) =>
                    [events.at(-1), { type: 'delta', seq: 2, text: 'b' }, { type: 'delta', seq: 1, text: 'a' }].map(
                        (event) => event,
                    ),
                ),
            ),
        },
    ],
    [
        'a reply with two endings',
        'engine-api.chat.reply-stream',
        {
            tamper: replace(on('GET', STREAM), (_, response) =>
                editReply(response, (events) => [...events, events.at(-1)]),
            ),
        },
    ],
    [
        'a reply too short to resume',
        'engine-api.chat.resume-no-duplicates',
        { tamper: replace(on('GET', STREAM), (_, response) => editReply(response, (events) => events.slice(-1))) },
    ],
    [
        'a resumed reply that starts over',
        'engine-api.chat.resume-no-duplicates',
        {
            tamper: replace(
                on('GET', STREAM, (request) => request.headers.has('last-event-id')),
                () => sse([delta(1), delta(2)]),
            ),
        },
    ],
    [
        'a new secret already revoked elsewhere',
        'engine-api.secrets.lifecycle',
        {
            tamper: editJson(on('POST', /^\/secrets$/), (secret) => ({
                ...secret,
                status: 'revoked',
                scope: { kind: 'agent', agentId: 'agent-x' },
            })),
        },
    ],
    [
        'a replaced secret that changed',
        'engine-api.secrets.lifecycle',
        {
            tamper: editJson(on('PUT', /\/value$/), (secret) => ({
                ...secret,
                name: 'other',
                status: 'revoked',
                createdAt: '2000-01-01T00:00:00Z',
                updatedAt: '2000-01-01T00:00:00Z',
            })),
        },
    ],
    [
        'a revoke that keeps it active',
        'engine-api.secrets.lifecycle',
        {
            tamper: chain(
                editJson(on('POST', /\/revoke$/), (secret) => ({ ...secret, status: 'active' })),
                editJson(on('GET', /^\/secrets$/), (page) => ({
                    ...page,
                    items: page.items.map((secret: any) => ({ ...secret, status: 'active' })),
                })),
            ),
        },
    ],
    [
        'a revoked secret still replaceable',
        'engine-api.secrets.lifecycle',
        {
            tamper: replace(on('PUT', /\/value$/), (_, response) =>
                response.status === 409 ? problem('not-found', 404) : response,
            ),
        },
    ],
    [
        'a deleted secret still listed',
        'engine-api.secrets.lifecycle',
        {
            tamper: chain(
                fromCall(
                    2,
                    editJson(on('GET', /^\/secrets$/), (page) => ({
                        ...page,
                        items: [{ ...page.items[0] }, ...page.items],
                    })),
                    on('GET', /^\/secrets$/),
                ),
                replace(on('POST', /\/revoke$/), (_, response) =>
                    response.status === 404 ? Response.json({}) : response,
                ),
            ),
        },
    ],
    [
        'an audit page with one entry',
        'engine-api.audit.hash-chain',
        { tamper: editJson(on('GET', /^\/audit$/), (page) => ({ ...page, items: page.items.slice(0, 1) })) },
    ],
    [
        'an audit page with a gap',
        'engine-api.audit.hash-chain',
        {
            tamper: editJson(on('GET', /^\/audit$/), (page) => ({
                ...page,
                items: [page.items[0], ...page.items.slice(2)],
            })),
        },
    ],
    [
        'an audit chain with a wrong link',
        'engine-api.audit.hash-chain',
        {
            tamper: editJson(on('GET', /^\/audit$/), (page) => ({
                ...page,
                items: [{ ...page.items[0], prevHash: '0'.repeat(64) }, ...page.items.slice(1)],
            })),
        },
    ],
    [
        'a broken verification',
        'engine-api.audit.hash-chain',
        {
            tamper: editJson(on('GET', /^\/audit\/verify$/), (result) => ({
                ...result,
                status: 'broken',
                firstBrokenSeq: 1,
                lastSeq: 1,
            })),
        },
    ],
    [
        'an owner without every permission',
        'engine-api.permissions.owner-holds-all',
        { tamper: editJson(on('GET', /^\/me$/), (me) => ({ ...me, permissions: me.permissions.slice(1) })) },
    ],
    [
        'a refusal naming another permission',
        'engine-api.permissions.mutations-denied',
        {
            tamper: replace(on('POST', /^\/folders$/), (_, response) =>
                response.status === 403 ? problem('forbidden', 403, { requiredPermission: 'audit.read' }) : response,
            ),
        },
    ],
    [
        'a refusal with another code',
        'engine-api.permissions.mutations-denied',
        {
            tamper: replace(on('POST', /^\/folders$/), (_, response) =>
                response.status === 403 ? problem('not-found', 404) : response,
            ),
        },
    ],
    [
        'a denial never audited',
        'engine-api.permissions.denials-audited',
        { tamper: editJson(on('GET', /^\/audit$/, query('outcome', 'denied')), (page) => ({ ...page, items: [] })) },
    ],
    [
        'a read refused to a reader',
        'engine-api.permissions.read-only-member',
        {
            tamper: replace(on('GET', /^\/folders$/), () =>
                problem('forbidden', 403, { requiredPermission: 'agents.read' }),
            ),
        },
    ],
    [
        'own sessions that are not all own',
        'engine-api.me.own-sessions',
        {
            tamper: editJson(on('GET', /^\/me\/sessions$/), (page) => ({
                ...page,
                items: page.items.map((session: any) => ({ ...session, memberId: 'member-other' })),
            })),
        },
    ],
    [
        'no current session',
        'engine-api.me.own-sessions',
        {
            tamper: editJson(on('GET', /^\/me\/sessions$/), (page) => ({
                ...page,
                items: page.items.map((session: any) => ({ ...session, current: false })),
            })),
        },
    ],
    [
        'revoke-others miscounting',
        'engine-api.me.own-sessions',
        {
            tamper: chain(
                editJson(on('POST', /revoke-others$/), () => ({ revoked: 5 })),
                fromCall(
                    2,
                    editJson(on('GET', /^\/me\/sessions$/), (page) => ({
                        ...page,
                        items: [...page.items, { ...page.items[0], id: 'session-other', current: false }],
                    })),
                    on('GET', /^\/me\/sessions$/),
                ),
            ),
        },
    ],
    [
        'a revoked session still working',
        'engine-api.me.own-sessions',
        {
            tamper: replace(on('GET', /^\/me$/), (_, response) =>
                response.status === 401 ? Response.json({}) : response,
            ),
        },
    ],
    [
        'own passkeys that are not all own',
        'engine-api.me.own-passkeys',
        {
            tamper: editJson(on('GET', /^\/me\/passkeys$/), (page) => ({
                ...page,
                items: page.items.map((passkey: any) => ({ ...passkey, memberId: 'member-other' })),
            })),
        },
    ],
    [
        'the last passkey revoked',
        'engine-api.me.own-passkeys',
        { tamper: editJson(on('GET', /^\/me\/passkeys$/), (page) => ({ ...page, items: page.items.slice(0, 1) })) },
    ],
    [
        'a passkey revoke refused',
        'engine-api.me.own-passkeys',
        { tamper: replace(on('DELETE', /^\/me\/passkeys\//), () => problem('last-passkey', 409)) },
    ],
    [
        'a revoked passkey still listed',
        'engine-api.me.own-passkeys',
        { tamper: firstAnswerAgain(on('GET', /^\/me\/passkeys$/)) },
    ],
    [
        "another member's session refused with 403",
        'engine-api.me.others-credentials-404',
        { tamper: replace(on('DELETE', /^\/me\/sessions\//), () => problem('forbidden', 403)) },
    ],
    [
        'an owner without a current session',
        'engine-api.me.others-credentials-404',
        { tamper: editJson(on('GET', /^\/me\/sessions$/), (page) => ({ ...page, items: [] })) },
    ],
    [
        'a private agent refused with a conflict',
        'engine-api.cross-member.private-resources',
        {
            tamper: replace(on('PATCH', /^\/agents\//), (_, response) =>
                response.status === 403 ? problem('agent-deleted', 409) : response,
            ),
        },
    ],
    [
        "a refusal to write in another member's thread",
        'engine-api.cross-member.shared-threads',
        { tamper: replace(on('POST', /^\/chats\/[^/]+\/messages$/), () => problem('forbidden', 403)) },
    ],
    [
        "another member's message credited to someone else",
        'engine-api.cross-member.shared-threads',
        {
            tamper: editJson(on('POST', /^\/chats\/[^/]+\/messages$/), (sent) => ({
                ...sent,
                message: { ...sent.message, createdBy: 'member-somebody-else' },
            })),
        },
    ],
    [
        'a cross-site refusal that is not 403',
        'engine-api.gateway.cross-site-refused',
        {
            tamper: replace(on('POST', /^\/folders$/), (_, response) =>
                response.status === 403 ? problem('validation-failed', 400) : response,
            ),
        },
    ],
    [
        'a sign-in redirect that drops the path',
        'engine-api.gateway.sign-in-keeps-next',
        { tamper: replace(page('/conformance/'), () => redirectTo('/auth/sign-in')) },
    ],
    [
        'a sign-in redirect that loses the query',
        'engine-api.gateway.sign-in-keeps-next',
        {
            tamper: replace(page('/conformance/'), (request) =>
                redirectTo(`/auth/sign-in?next=${encodeURIComponent(new URL(request.url).pathname)}`),
            ),
        },
    ],
    [
        'a sign-in redirect that keeps an off-origin next',
        'engine-api.gateway.sign-in-keeps-next',
        { tamper: replace(page('//'), () => redirectTo('/auth/sign-in?next=%2F%2Fconformance.invalid')) },
    ],
    [
        'the sign-in page served in place',
        'engine-api.gateway.sign-in-keeps-next',
        { tamper: replace(page('/conformance/'), () => new Response('<!doctype html>', { status: 200 })) },
    ],
    [
        'a redirect to another origin',
        'engine-api.gateway.sign-in-keeps-next',
        { tamper: replace(page('/conformance/'), () => redirectTo('https://evil.example/auth/sign-in')) },
    ],
];

const SKIPS: readonly Case[] = [
    ['no engine key', 'engine-api.engine.id-matches-key', {}, (target) => without(target, 'enginePublicKey')],
    [
        'a malformed engine key',
        'engine-api.engine.id-matches-key',
        {},
        (target) => ({ ...target, enginePublicKey: 'x' }),
    ],
    [
        'an engine without a gateway',
        'engine-api.gateway.cross-site-refused',
        {},
        (target) => ({ ...target, gateway: false }),
    ],
    [
        'an engine without a gateway in front of its pages',
        'engine-api.gateway.sign-in-keeps-next',
        {},
        (target) => ({ ...target, gateway: false }),
    ],
    [
        'an engine without activity',
        'engine-api.activity.agent-names',
        { tamper: editJson(on('GET', /^\/activity$/), (page) => ({ ...page, items: [] })) },
    ],
    [
        'a member without passkeys',
        'engine-api.me.own-passkeys',
        { tamper: editJson(on('GET', /^\/me\/passkeys$/), (page) => ({ ...page, items: [] })) },
    ],
    [
        'a passkey revoke needing step-up',
        'engine-api.me.own-passkeys',
        { tamper: replace(on('DELETE', /^\/me\/passkeys\//), () => problem('step-up-required', 401)) },
    ],
    [
        'body checks all behind step-up',
        'engine-api.input.unknown-body-field',
        {
            tamper: async (request, response) =>
                (await request.text()).includes('conformanceUnknownField')
                    ? problem('step-up-required', 401)
                    : response,
        },
    ],
    [
        'permission checks without members',
        'engine-api.permissions.mutations-denied',
        {},
        (target) => ({
            ...target,
            session: (subject) => (subject.kind === 'owner' ? target.session(subject) : Promise.resolve(null)),
        }),
    ],
    [
        'checks without an owner',
        'engine-api.agents.create-and-list',
        {},
        (target) => ({ ...target, session: () => Promise.resolve(null) }),
    ],
];

function named(cases: readonly Case[]) {
    return cases.map(([name, id, options, adjust]) => ({ name, id, options, adjust }));
}

describe('each assertion bites', () => {
    it.each(named(FAILS))('fails on $name', async ({ id, options, adjust }) => {
        expect((await outcome(id, options, adjust)).kind).toBe('fail');
    });

    it.each(named(SKIPS))('skips on $name', async ({ id, options, adjust }) => {
        expect((await outcome(id, options, adjust)).kind).toBe('skip');
    });

    it('works around an API token create that needs step-up', async () => {
        const tamper = replace(on('POST', /^\/api-tokens$/), (_, response) =>
            response.status === 201 ? problem('step-up-required', 401) : response,
        );
        expect(await outcome('engine-api.permissions.mutations-denied', { tamper })).toEqual({ kind: 'pass' });
    });

    it('accepts any name for an agent the engine no longer answers', async () => {
        const tamper = chain(
            replace(on('GET', /^\/agents\/[^/]+$/), () => problem('not-found', 404)),
            editJson(on('GET', /^\/activity$/), (page) => ({
                ...page,
                items: page.items.map((item: any) =>
                    item.agentId === null ? item : { ...item, agentName: 'Before the rename' },
                ),
            })),
        );
        expect(await outcome('engine-api.activity.agent-names', { tamper })).toEqual({ kind: 'pass' });
    });

    it('runs the auth check with placeholders when there is no owner', async () => {
        const result = await outcome('engine-api.auth.unauthenticated-401', {}, (target) => ({
            ...target,
            session: () => Promise.resolve(null),
        }));
        expect(result).toEqual({ kind: 'pass' });
    });
});

const RUNS = /^\/runs$/;
const CANCEL = /^\/runs\/[^/]+\/cancel$/;
const RETRY = /^\/runs\/[^/]+\/retry$/;
const TRIGGERS = /^\/triggers$/;
const FILES = /^\/files$/;
const CONTENT = /^\/files\/[^/]+\/content$/;
const INTEGRATIONS = /^\/integrations$/;
const ACTIVITY = /^\/activity$/;
const TASKS = /^\/tasks$/;
const TASK = /^\/tasks\/[^/]+$/;
const OCCURRENCES = /^\/tasks\/[^/]+\/occurrences$/;
const RUN = /^\/runs\/[^/]+$/;
const mapItems = (edit: (item: any, index: number) => unknown) => (page: any) => ({
    ...page,
    items: page.items.map(edit),
});
const reversed = (page: any) => ({ ...page, items: [...page.items].reverse() });
const emptied = (page: any) => ({ ...page, items: [] });
const firstItem = (edit: (item: any) => unknown) => (page: any) => ({
    ...page,
    items: page.items.map((item: any, index: number) => (index === 0 ? edit(item) : item)),
});
const withHeaders = (headers: Record<string, string>) => async (_: Request, response: Response) => {
    const copy = new Headers(response.headers);
    for (const [name, value] of Object.entries(headers)) copy.set(name, value);
    return new Response(await response.arrayBuffer(), { status: response.status, headers: copy });
};

const CAPABILITY_FAILS: readonly Case[] = [
    [
        'an engine-owned task naming a project source',
        'engine-api.tasks.inventory',
        {
            tamper: editJson(
                on('GET', TASKS),
                firstItem((task) => ({ ...task, kind: 'engine', sourcePath: 'x.book' })),
            ),
        },
    ],
    [
        'a reopened task that never completed, with progress past its total',
        'engine-api.tasks.inventory',
        {
            tamper: editJson(
                on('GET', TASKS),
                firstItem((task) => ({
                    ...task,
                    reopened: true,
                    doneCount: 0,
                    lastDoneAt: '2026-01-01T00:00:00Z',
                    progress: { completed: 3, total: 1, summary: null },
                    parent: { taskId: task.id, name: task.name },
                })),
            ),
        },
    ],
    [
        'a state filter listing another state and leaving the task out',
        'engine-api.tasks.inventory',
        {
            tamper: editJson(
                on('GET', TASKS, query('state')),
                mapItems((task, index) => (index === 0 ? { ...task, state: 'retired' } : task)),
            ),
        },
    ],
    [
        'a kind filter listing another kind',
        'engine-api.tasks.inventory',
        {
            tamper: editJson(
                on('GET', TASKS, query('kind')),
                firstItem((task) => ({ ...task, kind: 'engine' === task.kind ? 'ordinary' : 'engine' })),
            ),
        },
    ],
    [
        'an agent filter listing another agent’s task',
        'engine-api.tasks.inventory',
        {
            tamper: editJson(
                on('GET', TASKS, query('agentId')),
                firstItem((task) => ({ ...task, agentId: 'agent-elsewhere' })),
            ),
        },
    ],
    [
        'a task read answering another name',
        'engine-api.tasks.inventory',
        { tamper: editJson(on('GET', TASK), (task) => ({ ...task, name: 'Another task' })) },
    ],
    [
        'parents without children and prerequisites blocking nothing',
        'engine-api.tasks.relations',
        { tamper: editJson(on('GET', TASK), (task) => ({ ...task, children: [], blocks: [] })) },
    ],
    [
        'every dependency met and an unresolved one pending',
        'engine-api.tasks.relations',
        {
            tamper: editJson(on('GET', TASK), (task) => ({
                ...task,
                dependsOn: task.dependsOn.map((dependency: any) => ({
                    ...dependency,
                    state: dependency.taskId === null ? 'pending' : 'met',
                })),
            })),
        },
    ],
    [
        'a child that names another parent',
        'engine-api.tasks.relations',
        {
            tamper: editJson(on('GET', TASK), (task) => ({
                ...task,
                children: [...task.children, { taskId: 'task-engine-update', name: 'Update', state: 'not-ready' }],
            })),
        },
    ],
    [
        'occurrences oldest first',
        'engine-api.tasks.occurrences',
        { tamper: editJson(on('GET', OCCURRENCES), reversed) },
    ],
    [
        'an occurrence of another task, listed twice',
        'engine-api.tasks.occurrences',
        {
            tamper: editJson(on('GET', OCCURRENCES), (page) => ({
                ...page,
                items: [...page.items, ...page.items].map((item: any) => ({ ...item, taskId: 'task-elsewhere' })),
            })),
        },
    ],
    [
        'a retry that names nothing, and one of a completed occurrence',
        'engine-api.tasks.occurrences',
        {
            tamper: editJson(
                on('GET', OCCURRENCES),
                mapItems((item, index) =>
                    index === 0 ? { ...item, reason: 'retry', retryOf: null } : { ...item, state: 'completed' },
                ),
            ),
        },
    ],
    [
        'a newer occurrence in an earlier cycle',
        'engine-api.tasks.occurrences',
        {
            tamper: editJson(
                on('GET', OCCURRENCES),
                mapItems((item, index) => ({ ...item, cycle: index + 1 })),
            ),
        },
    ],
    [
        'a task run that does not link back',
        'engine-api.tasks.occurrences',
        { tamper: editJson(on('GET', RUN), (run) => ({ ...run, taskId: null, occurrenceId: null })) },
    ],
    [
        'an unknown task answered with a server error',
        'engine-api.tasks.unknown',
        { tamper: replace(on('GET', /^\/tasks\/conformance-no-such-task/), () => problem('internal-error', 500)) },
    ],
    [
        'runs paged out of order',
        'engine-api.runs.paging',
        { tamper: editJson(on('GET', RUNS, query('limit', '3')), reversed) },
    ],
    [
        'a failed-runs filter listing another status',
        'engine-api.runs.paging',
        {
            tamper: editJson(
                on('GET', RUNS, query('status', 'failed')),
                firstItem((run) => ({ ...run, status: 'completed' })),
            ),
        },
    ],
    [
        'an agent filter listing another agent',
        'engine-api.runs.paging',
        {
            tamper: editJson(
                on('GET', RUNS, query('agentId')),
                firstItem((run) => ({ ...run, agentId: 'agent-elsewhere' })),
            ),
        },
    ],
    [
        'a source filter leaving everything out',
        'engine-api.runs.paging',
        { tamper: editJson(on('GET', RUNS, query('source')), emptied) },
    ],
    [
        'a cancel without cancelRequestedAt',
        'engine-api.runs.cancel-idempotent',
        { tamper: editJson(on('POST', CANCEL), (run) => ({ ...run, cancelRequestedAt: null })) },
    ],
    [
        'a second cancel moving cancelRequestedAt',
        'engine-api.runs.cancel-idempotent',
        {
            tamper: fromCall(
                2,
                editJson(on('POST', CANCEL), (run) => ({ ...run, cancelRequestedAt: '2020-01-01T00:00:00Z' })),
                on('POST', CANCEL),
            ),
        },
    ],
    [
        'a second cancel refused as not found',
        'engine-api.runs.cancel-idempotent',
        {
            tamper: fromCall(
                2,
                replace(on('POST', CANCEL), () => problem('not-found', 404)),
                on('POST', CANCEL),
            ),
        },
    ],
    [
        'a cancel refused for a run in progress',
        'engine-api.runs.cancel-idempotent',
        {
            tamper: replace(on('POST', CANCEL), (_, response) =>
                response.status === 202 ? problem('not-found', 404) : response,
            ),
        },
    ],
    [
        'a retry naming another run',
        'engine-api.runs.retry-only-failed',
        {
            tamper: editJson(on('POST', RETRY), (run) => ({
                ...run,
                retryOf: 'run-elsewhere',
                agentId: 'agent-elsewhere',
                status: 'completed',
            })),
        },
    ],
    [
        'triggers paged out of order and the created ones missing',
        'engine-api.triggers.paging',
        { tamper: editJson(on('GET', TRIGGERS, query('agentId')), reversed) },
    ],
    [
        'a trigger filter listing other kinds and lifecycles',
        'engine-api.triggers.paging',
        {
            tamper: chain(
                editJson(
                    on('GET', TRIGGERS, query('kind')),
                    firstItem((trigger) => ({ ...trigger, kind: 'email', config: { address: 'x@example.com' } })),
                ),
                editJson(
                    on('GET', TRIGGERS, query('lifecycle', 'active')),
                    firstItem((trigger) => ({ ...trigger, lifecycle: 'paused' })),
                ),
                editJson(on('GET', TRIGGERS, query('agentId')), emptied),
            ),
        },
    ],
    [
        'a pause and a resume that do not change the lifecycle',
        'engine-api.triggers.pause-resume-idempotent',
        {
            tamper: chain(
                editJson(on('POST', /^\/triggers\/[^/]+\/pause$/), (trigger) => ({
                    ...trigger,
                    lifecycle: 'active',
                    nextFireAt: '2030-01-01T00:00:00Z',
                })),
                editJson(on('POST', /^\/triggers\/[^/]+\/resume$/), (trigger) => ({ ...trigger, lifecycle: 'paused' })),
            ),
        },
    ],
    [
        'a second resume that changes the trigger again',
        'engine-api.triggers.pause-resume-idempotent',
        {
            tamper: fromCall(
                2,
                editJson(on('POST', /^\/triggers\/[^/]+\/resume$/), (trigger) => ({
                    ...trigger,
                    updatedAt: '2030-01-01T00:00:00Z',
                })),
                on('POST', /^\/triggers\/[^/]+\/resume$/),
            ),
        },
    ],
    [
        'a bad schedule refused with another problem',
        'engine-api.triggers.invalid-schedule',
        {
            tamper: replace(on('POST', TRIGGERS), (_, response) =>
                response.status === 422 ? problem('validation-failed', 400) : response,
            ),
        },
    ],
    [
        'files missing from their own listing, and filters listing others',
        'engine-api.files.paging',
        {
            tamper: chain(
                editJson(on('GET', FILES, query('q')), (page) => ({
                    ...page,
                    items: [...page.items].reverse().slice(1),
                })),
                editJson(
                    on('GET', FILES, query('purpose')),
                    firstItem((file) => ({ ...file, purpose: 'knowledge' })),
                ),
                editJson(
                    on('GET', FILES, query('scan')),
                    firstItem((file) => ({ ...file, scan: { status: 'failed', checkedAt: null } })),
                ),
            ),
        },
    ],
    [
        'a scan set listing another status',
        'engine-api.files.paging',
        {
            tamper: editJson(
                on('GET', FILES, query('scan', 'infected,failed')),
                firstItem((file) => ({ ...file, scan: { status: 'clean', checkedAt: null } })),
            ),
        },
    ],
    [
        'stats whose purpose and scan counts disagree',
        'engine-api.files.stats',
        {
            tamper: editJson(on('GET', /^\/files\/stats$/), (stats) => ({
                ...stats,
                byScan: { ...stats.byScan, clean: Number(stats.byScan.clean) + 1 },
            })),
        },
    ],
    [
        'stats that do not count a new upload',
        'engine-api.files.stats',
        { tamper: firstAnswerAgain(on('GET', /^\/files\/stats$/)) },
    ],
    [
        'a policy answered for another purpose',
        'engine-api.files.upload-policy',
        {
            tamper: editJson(on('GET', /^\/files\/upload-policy$/, query('purpose', 'output')), (policy) => ({
                ...policy,
                purpose: 'upload',
            })),
        },
    ],
    [
        'an unaccepted type refused with another problem',
        'engine-api.files.upload-policy',
        {
            tamper: replace(on('POST', FILES), (_, response) =>
                response.status === 415 ? problem('validation-failed', 400) : response,
            ),
        },
    ],
    [
        'an unaccepted type and an oversized file stored',
        'engine-api.files.upload-policy',
        {
            uploadPolicies: {},
            tamper: editJson(on('GET', /^\/files\/upload-policy$/, query('purpose', 'knowledge')), (policy) => ({
                ...policy,
                maxBytes: 4,
                accept: ['.md'],
            })),
        },
    ],
    [
        'content without attachment, nosniff or the same bytes',
        'engine-api.files.download-attachment',
        {
            tamper: chain(
                replace(
                    on('GET', CONTENT),
                    withHeaders({ 'content-disposition': 'inline', 'x-content-type-options': 'none' }),
                ),
                replace(on('GET', CONTENT, query('version')), () => new Response('other', { status: 200 })),
            ),
        },
    ],
    [
        'content refused and no versions',
        'engine-api.files.download-attachment',
        {
            tamper: chain(
                replace(on('GET', CONTENT), () => problem('not-found', 404)),
                editJson(on('GET', /^\/files\/[^/]+\/versions$/), emptied),
            ),
        },
    ],
    [
        'an infected version downloadable',
        'engine-api.files.infected-refused',
        {
            tamper: replace(
                on('GET', CONTENT, query('version')),
                () =>
                    new Response('MZ', {
                        headers: {
                            'content-type': 'application/octet-stream',
                            'content-disposition': 'attachment',
                            'x-content-type-options': 'nosniff',
                        },
                    }),
            ),
        },
    ],
    [
        'an infected version refused with another problem',
        'engine-api.files.infected-refused',
        { tamper: replace(on('GET', CONTENT, query('version')), () => problem('not-found', 404)) },
    ],
    [
        'integrations missing from their listing, and filters listing others',
        'engine-api.integrations.paging',
        {
            tamper: chain(
                editJson(on('GET', INTEGRATIONS, query('agentId')), reversed),
                editJson(on('GET', INTEGRATIONS, query('agentId', undefined)), (page) => ({
                    ...page,
                    items: page.items.slice(1),
                })),
                editJson(
                    on('GET', INTEGRATIONS, query('kind')),
                    firstItem((item) => ({
                        ...item,
                        kind: 'repository',
                        config: { provider: 'github', repository: 'a/b' },
                    })),
                ),
                editJson(
                    on('GET', INTEGRATIONS, query('status')),
                    firstItem((item) => ({ ...item, status: 'error' })),
                ),
            ),
        },
    ],
    [
        'a status set that lists another status',
        'engine-api.integrations.paging',
        {
            tamper: editJson(on('GET', INTEGRATIONS, query('status', 'needs-attention,error')), (page) => ({
                ...page,
                items: [{ ...page.items[0], status: 'connected' }, ...page.items.slice(1)],
            })),
        },
    ],
    [
        'an agent listing without its engine-wide integrations',
        'engine-api.integrations.paging',
        {
            tamper: editJson(on('GET', INTEGRATIONS, query('includeEngineWide', 'true')), (page) => ({
                ...page,
                items: page.items.filter((item: { agentId: string | null }) => item.agentId !== null),
            })),
        },
    ],
    [
        'integration stats that do not count a new integration',
        'engine-api.integrations.stats',
        { tamper: firstAnswerAgain(on('GET', /^\/integrations\/stats$/, query('agentId'))) },
    ],
    [
        'engine-wide integration stats lower than an agent\u2019s',
        'engine-api.integrations.stats',
        {
            tamper: editJson(
                on('GET', /^\/integrations\/stats$/, (request) => !query('agentId')(request)),
                (stats) => ({
                    ...stats,
                    disconnected: 0,
                }),
            ),
        },
    ],
    [
        'a secret reference that is not resolved',
        'engine-api.integrations.secrets-never-returned',
        { tamper: editJson(on('POST', INTEGRATIONS), (integration) => ({ ...integration, secretRefs: [] })) },
    ],
    [
        'activity of an unknown kind and one without a valid base',
        'engine-api.activity.known-items',
        {
            tamper: editJson(on('GET', ACTIVITY), (page) => ({
                ...page,
                items: [{ ...page.items[0], kind: 'run.teleported' }, { kind: 'run.started' }, ...page.items.slice(1)],
            })),
        },
    ],
    [
        'activity out of order, and a kind prefix listing another area',
        'engine-api.activity.paging',
        {
            tamper: chain(
                editJson(on('GET', ACTIVITY, query('limit', '3')), reversed),
                editJson(on('GET', ACTIVITY, query('kind', 'run.')), (page) => ({
                    ...page,
                    items: [
                        ...page.items.map((item: any) => ({ ...item, kind: 'file.deleted' })),
                        ...page.items,
                    ].reverse(),
                })),
            ),
        },
    ],
    [
        'a second cancel saying finished for a run still going',
        'engine-api.runs.cancel-idempotent',
        {
            tamper: fromCall(
                2,
                replace(on('POST', CANCEL), () => problem('run-finished', 409)),
                on('POST', CANCEL),
            ),
        },
    ],
    [
        'a bad schedule refused without naming the field',
        'engine-api.triggers.invalid-schedule',
        {
            tamper: replace(on('POST', TRIGGERS), (_, response) =>
                response.status === 422 ? problem('invalid-schedule', 422) : response,
            ),
        },
    ],
    [
        'a bad schedule accepted',
        'engine-api.triggers.invalid-schedule',
        {
            tamper: replace(on('POST', TRIGGERS), (_, response) =>
                response.status === 422
                    ? Response.json(
                          {
                              id: 'trigger-accepted',
                              agentId: 'agent-x',
                              agentName: 'Agent X',
                              name: 'Accepted',
                              kind: 'email',
                              lifecycle: 'active',
                              endedReason: null,
                              lastFiredAt: null,
                              nextFireAt: null,
                              createdBy: 'member-owner',
                              createdAt: '2026-10-01T00:00:00Z',
                              updatedAt: '2026-10-01T00:00:00Z',
                              config: { address: 'x@example.com' },
                          },
                          { status: 201 },
                      )
                    : response,
            ),
        },
    ],
    [
        'a trigger that names another agent',
        'engine-api.triggers.paging',
        {
            tamper: editJson(
                on('GET', TRIGGERS),
                firstItem((trigger) => ({ ...trigger, agentName: 'Someone else' })),
            ),
        },
    ],
    [
        'trigger stats that do not count a new schedule',
        'engine-api.triggers.stats',
        { tamper: firstAnswerAgain(on('GET', /^\/triggers\/stats$/)) },
    ],
    [
        'trigger stats whose next fire is after an active trigger’s',
        'engine-api.triggers.stats',
        {
            tamper: editJson(on('GET', /^\/triggers\/stats$/), (stats) => ({
                ...stats,
                nextFireAt: '2099-01-01T00:00:00Z',
            })),
        },
    ],
    [
        'an ended trigger that a refused resume brings back',
        'engine-api.triggers.pause-resume-idempotent',
        {
            tamper: editJson(on('GET', /^\/triggers\/trigger-fake-ended$/), (trigger) => ({
                ...trigger,
                lifecycle: 'active',
                endedReason: null,
            })),
        },
    ],
    [
        'activity that names another agent',
        'engine-api.activity.agent-names',
        {
            tamper: editJson(on('GET', ACTIVITY), (page) => ({
                ...page,
                items: page.items.map((item: any) =>
                    item.agentId === null ? item : { ...item, agentName: 'Someone else' },
                ),
            })),
        },
    ],
    [
        'activity without an agent that names one',
        'engine-api.activity.agent-names',
        {
            tamper: editJson(on('GET', ACTIVITY), (page) => ({
                ...page,
                items: page.items.map((item: any) => (item.agentId === null ? { ...item, agentName: 'Ghost' } : item)),
            })),
        },
    ],
    [
        'an activity feed that fails',
        'engine-api.activity.known-items',
        { tamper: replace(on('GET', ACTIVITY), () => problem('unavailable', 503)) },
    ],
    [
        'an activity page without items',
        'engine-api.activity.known-items',
        { tamper: replace(on('GET', ACTIVITY), () => Response.json({ nextCursor: null })) },
    ],
    [
        'a run activity page with an item that has no base',
        'engine-api.activity.paging',
        {
            tamper: chain(
                editJson(on('GET', ACTIVITY, query('kind', 'run.')), (page) => ({
                    ...page,
                    items: [
                        { kind: 'run.started' },
                        { ...page.items[0], kind: 'file.deleted', name: 7 },
                        ...page.items,
                    ],
                })),
            ),
        },
    ],
];

const CAPABILITY_SKIPS: readonly Case[] = [
    ['no task at all', 'engine-api.tasks.inventory', { tamper: editJson(on('GET', TASKS), emptied) }],
    [
        'no task with a parent or a dependency',
        'engine-api.tasks.relations',
        {
            tamper: editJson(
                on('GET', TASKS),
                mapItems((task) => ({ ...task, parent: null, dependsOn: [] })),
            ),
        },
    ],
    [
        'no task that ran or repeats',
        'engine-api.tasks.occurrences',
        {
            tamper: editJson(
                on('GET', TASKS),
                mapItems((task) => ({ ...task, doneCount: 0, lastDoneAt: null, reopened: false, repeat: null })),
            ),
        },
    ],
    [
        'no run for a chat turn',
        'engine-api.runs.cancel-idempotent',
        { tamper: editJson(on('GET', RUNS, query('source', 'web')), emptied) },
    ],
    [
        'no finished run to retry',
        'engine-api.runs.retry-only-failed',
        { tamper: editJson(on('GET', RUNS, query('status')), emptied) },
    ],
    [
        'no ended trigger',
        'engine-api.triggers.pause-resume-idempotent',
        { tamper: editJson(on('GET', TRIGGERS, query('lifecycle', 'ended')), emptied) },
    ],
    [
        'an upload the scanner flags',
        'engine-api.files.download-attachment',
        {
            tamper: editJson(on('POST', FILES), (file) => ({
                ...file,
                scan: { status: 'infected', checkedAt: file.createdAt },
            })),
        },
    ],
    [
        'no infected file',
        'engine-api.files.infected-refused',
        { tamper: editJson(on('GET', FILES, query('scan', 'infected')), emptied) },
    ],
];

describe('each capability assertion bites', () => {
    it.each(named(CAPABILITY_FAILS))('fails on $name', async ({ id, options, adjust }) => {
        expect((await outcome(id, options, adjust)).kind).toBe('fail');
    });

    it.each(named(CAPABILITY_SKIPS))('skips on $name', async ({ id, options, adjust }) => {
        expect((await outcome(id, options, adjust)).kind).toBe('skip');
    });
});
