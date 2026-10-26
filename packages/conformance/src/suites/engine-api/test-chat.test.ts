/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return --
   The edits below rewrite arbitrary JSON answers; typing every shape would hide what each case breaks. */
import { describe, expect, it } from 'vitest';

import type { CheckOutcome } from '../../check';
import { CHAT_MESSAGE } from '../../fixtures/books';
import { runConformance } from '../../runner';
import type { FakeEngineOptions, Tamper } from '../../testing/fake-engine';
import { createFakeEngine } from '../../testing/fake-engine';
import { ENGINE_API_SUITE } from './index';

const TEST_CHAT = /^\/api\/v1\/agents\/[^/]+\/test-chat$/;
const SOURCE = /^\/api\/v1\/agents\/[^/]+\/source$/;
const AUDIT = /^\/api\/v1\/audit$/;

const matches = (request: Request, method: string, pattern: RegExp): boolean =>
    request.method === method && pattern.test(new URL(request.url).pathname);

function sse(events: readonly Readonly<Record<string, unknown>>[], ids: readonly (string | null)[] = []): Response {
    const text = events.map((event, index) => {
        const id = ids[index] ?? (event['type'] === 'delta' ? String(event['seq']) : null);
        return `${id === null ? '' : `id: ${id}\n`}event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`;
    });
    return new Response(text.join(''), { headers: { 'content-type': 'text/event-stream' } });
}

function problem(code: string, status: number, extra: Record<string, unknown> = {}): Response {
    return new Response(JSON.stringify({ type: 'https://ptbk.io/problems/x', title: 'X', status, code, ...extra }), {
        status,
        headers: { 'content-type': 'application/problem+json' },
    });
}

const delta = (seq: number, text = 'x') => ({ type: 'delta', seq, text });
const completed = (content: string) => ({ type: 'completed', content });

/** Answers every test run with this stream instead of the engine's. */
const testRunAnswers =
    (make: () => Response): Tamper =>
    (request, response) =>
        matches(request, 'POST', TEST_CHAT) ? make() : response;

function editAuditEntries(edit: (entries: any[]) => any[]): Tamper {
    return async (request, response) => {
        const url = new URL(request.url);
        if (!matches(request, 'GET', AUDIT) || url.searchParams.get('action') !== 'agent.test-chat.start') {
            return response;
        }
        const page: { readonly items: any[] } = await response.json();
        return new Response(JSON.stringify({ ...page, items: edit(page.items) }), {
            status: response.status,
            headers: response.headers,
        });
    };
}

async function outcome(id: string, options: FakeEngineOptions): Promise<CheckOutcome> {
    const { target } = await createFakeEngine(options);
    const report = await runConformance({
        target,
        suites: [ENGINE_API_SUITE],
        filter: (check) => check.id === id,
        timeoutMs: 20_000,
        signal: AbortSignal.timeout(60_000),
        seed: 11,
    });
    return report.results[0]?.outcome ?? { kind: 'fail', detail: 'not run' };
}

const DRAFT = 'engine-api.test-chat.draft-reply';
const INVALID = 'engine-api.test-chat.invalid-book';
const LIMITS = 'engine-api.test-chat.limits';
const AUDITED = 'engine-api.test-chat.audit';

let sourceReads = 0;

const FAILS: readonly (readonly [name: string, id: string, tamper: Tamper])[] = [
    ['deltas that skip a seq', DRAFT, testRunAnswers(() => sse([delta(2), completed('x')]))],
    ['a delta whose SSE id is not its seq', DRAFT, testRunAnswers(() => sse([delta(1), completed('x')], ['7']))],
    ['two terminal events', DRAFT, testRunAnswers(() => sse([delta(1), completed('x'), completed('x')]))],
    ['no terminal event', DRAFT, testRunAnswers(() => sse([delta(1)]))],
    ['a delta after the terminal event', DRAFT, testRunAnswers(() => sse([completed(''), delta(1)]))],
    ['a completed reply that is not the deltas', DRAFT, testRunAnswers(() => sse([delta(1, 'a'), completed('b')]))],
    [
        'a failed reply',
        DRAFT,
        testRunAnswers(() =>
            sse([
                {
                    type: 'failed',
                    problem: { type: 'https://ptbk.io/problems/x', title: 'X', status: 502, code: 'reply-failed' },
                },
            ]),
        ),
    ],
    [
        'a test run that saves the book',
        DRAFT,
        async (request, response) => {
            if (!matches(request, 'GET', SOURCE)) return response;
            const source: { readonly source: string } = await response.json();
            return new Response(JSON.stringify({ ...source, source: `${source.source}${String(++sourceReads)}` }), {
                status: response.status,
                headers: response.headers,
            });
        },
    ],
    ['an invalid book without diagnostics', INVALID, testRunAnswers(() => problem('invalid-book', 422))],
    ['an invalid book that streams', INVALID, testRunAnswers(() => sse([delta(1), completed('x')]))],
    ['limits that accept anything', LIMITS, testRunAnswers(() => sse([completed('')]))],
    ['limits refused with the wrong code', LIMITS, testRunAnswers(() => problem('not-found', 404))],
    ['an entry per turn', AUDITED, editAuditEntries((entries) => [...entries, ...entries])],
    ['no entry at all', AUDITED, editAuditEntries(() => [])],
    [
        'an entry naming another member',
        AUDITED,
        editAuditEntries((entries) =>
            entries.map((entry) => ({ ...entry, actor: { ...entry.actor, memberId: 'member-someone-else' } })),
        ),
    ],
    [
        'an entry with the message in its details',
        AUDITED,
        editAuditEntries((entries) => entries.map((entry) => ({ ...entry, details: { message: CHAT_MESSAGE } }))),
    ],
];

describe('test-chat@1 checks', () => {
    it.each(FAILS)('fails on %s', async (_, id, tamper) => {
        expect((await outcome(id, { tamper })).kind).toBe('fail');
    });

    it.each([DRAFT, INVALID, LIMITS, AUDITED])('passes %s on a correct engine', async (id) => {
        expect((await outcome(id, {})).kind).toBe('pass');
    });

    it.each([DRAFT, INVALID, LIMITS, AUDITED])('skips %s when test-chat@1 is not advertised', async (id) => {
        expect(await outcome(id, { capabilities: [] })).toEqual({ kind: 'skip', reason: 'capability-not-advertised' });
    });
});
