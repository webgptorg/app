import { KNOWN_CAPABILITIES, RESERVED_CAPABILITIES, encodeLiveMedia } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import type { CheckOutcome } from '../../check';
import { runConformance } from '../../runner';
import type { FakeEngineOptions, LiveDefect, LiveTamper, Tamper } from '../../testing/fake-engine';
import { DEFAULT_CAPABILITIES } from '@ptbk/engine-api/in-memory';

import { createFakeEngine } from '../../testing/fake-engine';
import { ENGINE_API_SUITE } from './index';

async function outcome(id: string, options: FakeEngineOptions = {}): Promise<CheckOutcome> {
    const { target } = await createFakeEngine(options);
    const report = await runConformance({
        target,
        suites: [ENGINE_API_SUITE],
        filter: (check) => check.id === id,
        timeoutMs: 30_000,
        signal: AbortSignal.timeout(60_000),
        seed: 11,
    });
    const result = report.results.find((candidate) => candidate.id === id);
    if (!result) throw new Error(`no result for ${id}`);
    return result.outcome;
}

const AT = '2026-11-20T10:00:00.000Z';
const SESSION = {
    id: 'live-forged',
    kind: 'agent-tab',
    tabId: 'tab-forged',
    browser: 'default',
    mode: 'controlling',
    origin: null,
    status: 'open',
    endReason: null,
    helpRequestId: null,
    openedAt: AT,
    attachBy: AT,
    endsAt: AT,
};

const path = (request: Request): string => new URL(request.url).pathname.slice('/api/v1'.length);

/** Answers a matching refusal with a forged success, as an engine that skips the rule would. */
function forge(method: string, pattern: RegExp, status: number, body: unknown, onlyFor?: number): Tamper {
    return (request, response) =>
        request.method === method &&
        pattern.test(path(request)) &&
        (onlyFor === undefined || response.status === onlyFor)
            ? new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
            : response;
}

function edit(method: string, pattern: RegExp, change: (data: Record<string, unknown>) => unknown): Tamper {
    return async (request, response) => {
        if (request.method !== method || !pattern.test(path(request)) || response.status >= 300) return response;
        const data = (await response.json()) as Record<string, unknown>;
        return new Response(JSON.stringify(change(data)), { status: response.status, headers: response.headers });
    };
}

describe('the browser-tab checks', () => {
    it('skip without the capability or a way to reach the channel', async () => {
        expect(
            await outcome('engine-api.browser-tab.channel-auth', { capabilities: [KNOWN_CAPABILITIES.audit] }),
        ).toEqual({
            kind: 'skip',
            reason: 'capability-not-advertised',
        });
        expect(await outcome('engine-api.browser-tab.help-requests', { liveBrowser: false })).toMatchObject({
            kind: 'skip',
        });
    });

    it.each<[string, LiveDefect]>([
        ['engine-api.browser-tab.channel-auth', 'channel-without-cookie'],
        ['engine-api.browser-tab.channel-auth', 'channel-any-origin'],
        ['engine-api.browser-tab.channel-auth', 'channel-without-origin'],
        ['engine-api.browser-tab.channel-auth', 'channel-twice'],
        ['engine-api.browser-tab.session-binding', 'channel-any-session'],
        ['engine-api.browser-tab.step-up', 'step-up-ignored'],
        ['engine-api.browser-tab.watcher-input', 'watcher-input-silent'],
        ['engine-api.browser-tab.blocked-pages', 'frames-while-blocked'],
        ['engine-api.browser-tab.protocol-errors', 'protocol-errors-ignored'],
        ['engine-api.browser-tab.channel-handshake', 'oversized-media'],
        ['engine-api.browser-tab.time-limits', 'no-expiry'],
        ['engine-api.browser-tab.audit-metadata', 'typed-text-audited'],
    ])('%s fails an engine with %s', async (id, liveDefect) => {
        expect(await outcome(id, { liveDefect })).toMatchObject({ kind: 'fail' });
    });

    it.each<[string, string, Tamper]>([
        [
            'engine-api.browser-tab.session-binding',
            'another session reads the session',
            forge('GET', /^\/browser-sessions\/[^/]+$/, 200, SESSION, 404),
        ],
        [
            'engine-api.browser-tab.single-controller',
            'a second controller is let in',
            forge('POST', /^\/browser-tabs\/[^/]+\/control$/, 201, SESSION, 409),
        ],
        [
            'engine-api.browser-tab.single-controller',
            'the agent is not paused',
            edit('GET', /^\/browser-tabs$/, (data) => ({
                items: (data['items'] as Record<string, unknown>[]).map((tab) => ({ ...tab, agentState: 'working' })),
            })),
        ],
        [
            'engine-api.browser-tab.time-limits',
            'endsAt an hour away',
            edit('POST', /^\/browser-tabs\/[^/]+\/watch$/, (data) => ({
                ...data,
                endsAt: new Date(Date.parse(data['openedAt'] as string) + 3_600_000).toISOString(),
                attachBy: new Date(Date.parse(data['openedAt'] as string) + 600_000).toISOString(),
            })),
        ],
        [
            'engine-api.browser-tab.help-requests',
            'a wrong outcome',
            edit('GET', /^\/browser-help-requests\/[^/]+$/, (data) =>
                data['resolution'] === null
                    ? data
                    : { ...data, resolution: { ...(data['resolution'] as object), outcome: 'ended' } },
            ),
        ],
        [
            'engine-api.browser-tab.help-requests',
            'a request never listed',
            edit('GET', /^\/browser-help-requests$/, () => ({ items: [] })),
        ],
        [
            'engine-api.browser-tab.audit-metadata',
            'no browser entries',
            edit('GET', /^\/audit$/, (data) => ({ ...data, items: [] })),
        ],
    ])('%s fails an engine where %s', async (id, _what, tamper) => {
        expect(await outcome(id, { tamper })).toMatchObject({ kind: 'fail' });
    });
});

/** Rewrites one engine message type on the channel; `null` drops it. */
function rewrite(type: string, change: (message: Record<string, unknown>) => unknown): LiveTamper {
    return (text) => {
        const message = JSON.parse(text) as Record<string, unknown>;
        if (message['type'] !== type) return [text];
        const changed = change(message);
        return changed === null ? [] : [typeof changed === 'string' ? changed : JSON.stringify(changed)];
    };
}

function frame(seq: number): Uint8Array {
    const encoded = encodeLiveMedia({ kind: 'tab-frame-png', seq, timestamp: 0, payload: new Uint8Array(4) });
    if (encoded.kind !== 'ok') throw new Error('not encoded');
    return encoded.bytes;
}

const problem = (code: string, status: number): Response =>
    new Response(JSON.stringify({ type: `https://ptbk.io/problems/${code}`, title: code, status, code }), {
        status,
        headers: { 'content-type': 'application/problem+json' },
    });

describe('the browser-tab checks on the channel', () => {
    it.each<[string, string, LiveTamper]>([
        ['engine-api.browser-tab.channel-handshake', 'no hello', rewrite('hello', () => null)],
        [
            'engine-api.browser-tab.channel-handshake',
            'a hello for version 2',
            rewrite('hello', (m) => ({ ...m, version: 2 })),
        ],
        ['engine-api.browser-tab.channel-handshake', 'no state', rewrite('state', () => null)],
        [
            'engine-api.browser-tab.channel-handshake',
            'a watcher told it controls',
            rewrite('state', (m) => ({ ...m, mode: 'controlling' })),
        ],
        [
            'engine-api.browser-tab.channel-handshake',
            'another origin',
            rewrite('navigated', (m) => ({ ...m, origin: 'https://other.invalid' })),
        ],
        [
            'engine-api.browser-tab.channel-handshake',
            'frames past the credit',
            (text) => (text.includes('"navigated"') ? [text, frame(1), frame(2), frame(3)] : [text]),
        ],
        ['engine-api.browser-tab.channel-handshake', 'text that is not JSON', (text) => [text, '{not json']],
        [
            'engine-api.browser-tab.channel-handshake',
            'an unknown message with a URL',
            (text) => [text, JSON.stringify({ type: 'url', url: 'https://example.invalid/secret' })],
        ],
        ['engine-api.browser-tab.blocked-pages', 'no blocked', rewrite('blocked', () => null)],
        [
            'engine-api.browser-tab.blocked-pages',
            'blocked naming an origin',
            rewrite('blocked', (m) => ({ ...m, origin: m['origin'] ?? 'https://x.invalid' })),
        ],
        [
            'engine-api.browser-tab.blocked-pages',
            'the wrong reason',
            rewrite('blocked', (m) => ({ ...m, reason: 'browser-page', origin: null })),
        ],
        ['engine-api.browser-tab.blocked-pages', 'no refusal', rewrite('input-refused', () => null)],
        [
            'engine-api.browser-tab.blocked-pages',
            'no navigated back',
            (text) => (text.includes('"navigated"') && text.includes('blocked-') ? [] : [text]),
        ],
        ['engine-api.browser-tab.channel-handshake', 'neither navigated nor blocked', rewrite('navigated', () => null)],
    ])('%s fails an engine that sends %s', async (id, _what, liveTamper) => {
        expect(await outcome(id, { liveTamper })).toMatchObject({ kind: 'fail' });
    });

    it('fails when the channel cannot be opened at all', async () => {
        expect(
            await outcome('engine-api.browser-tab.channel-handshake', { liveDefect: 'channel-refused' }),
        ).toMatchObject({
            kind: 'fail',
        });
    });

    it('skips what needs a step-up the suite cannot give, a stale session or the audit log', async () => {
        const wantsStepUp: Tamper = (request, response) =>
            request.method === 'POST' && /^\/browser-(tabs\/[^/]+\/control|sessions)$/.test(path(request))
                ? problem('step-up-required', 401)
                : response;
        expect(await outcome('engine-api.browser-tab.single-controller', { tamper: wantsStepUp })).toMatchObject({
            kind: 'skip',
        });
        expect(await outcome('engine-api.browser-tab.audit-metadata', { tamper: wantsStepUp })).toMatchObject({
            kind: 'skip',
        });
        expect(await outcome('engine-api.browser-tab.step-up', { staleOwnerSessions: false })).toMatchObject({
            kind: 'skip',
        });
        expect(
            await outcome('engine-api.browser-tab.audit-metadata', {
                capabilities: [KNOWN_CAPABILITIES.browserTab, KNOWN_CAPABILITIES.wallet],
            }),
        ).toMatchObject({ kind: 'skip' });
    });

    it('fails an engine that advertises reserved live audio, and skips its unwritten check', async () => {
        const capabilities = [...DEFAULT_CAPABILITIES, RESERVED_CAPABILITIES.liveAudio];
        expect(await outcome('engine-api.live.reserved', { capabilities })).toMatchObject({ kind: 'fail' });
        expect(await outcome('engine-api.live-audio.session', { capabilities })).toEqual({
            kind: 'skip',
            reason: 'not-implemented',
        });
    });
});

const tabs = (change: (tab: Record<string, unknown>) => unknown) =>
    edit('GET', /^\/browser-tabs$/, (data) => ({
        items: (data['items'] as Record<string, unknown>[]).map(change),
    }));

describe('the browser-tab checks on the API', () => {
    it.each<[string, string, Tamper]>([
        [
            'engine-api.browser-tab.session-binding',
            'another session takes control',
            forge('POST', /^\/browser-sessions\/[^/]+\/control$/, 200, SESSION, 404),
        ],
        [
            'engine-api.browser-tab.session-binding',
            'the owner’s session ended',
            edit('GET', /^\/browser-sessions\/[^/]+$/, (data) => ({ ...data, status: 'ended', endReason: 'ended' })),
        ],
        ['engine-api.browser-tab.watcher-input', 'the agent paused', tabs((tab) => ({ ...tab, agentState: 'paused' }))],
        [
            'engine-api.browser-tab.single-controller',
            'a session that does not control',
            edit('POST', /^\/browser-tabs\/[^/]+\/control$/, (data) => ({ ...data, mode: 'watching' })),
        ],
        [
            'engine-api.browser-tab.single-controller',
            'a hand-back that keeps control',
            edit('POST', /^\/browser-sessions\/[^/]+\/hand-back$/, (data) => ({ ...data, mode: 'controlling' })),
        ],
        [
            'engine-api.browser-tab.single-controller',
            'the agent never resumes',
            tabs((tab) => ({ ...tab, agentState: 'paused' })),
        ],
        [
            'engine-api.browser-tab.help-requests',
            'the wrong reason',
            edit('GET', /^\/browser-help-requests\/[^/]+$/, (data) => ({ ...data, reason: 'login' })),
        ],
        [
            'engine-api.browser-tab.help-requests',
            'a request that never goes in progress',
            edit('GET', /^\/browser-help-requests\/[^/]+$/, (data) =>
                data['status'] === 'in-progress' ? { ...data, status: 'pending' } : data,
            ),
        ],
        ['engine-api.browser-tab.help-requests', 'a tab not waiting', tabs((tab) => ({ ...tab, helpRequestId: null }))],
        [
            'engine-api.browser-tab.help-requests',
            'control that does not answer the request',
            edit('POST', /^\/browser-tabs\/[^/]+\/control$/, (data) => ({ ...data, helpRequestId: null })),
        ],
        [
            'engine-api.browser-tab.help-requests',
            'a dismissal with another outcome',
            edit('POST', /^\/browser-help-requests\/[^/]+\/dismiss$/, (data) => ({
                ...data,
                resolution: { ...(data['resolution'] as object), outcome: 'ended' },
            })),
        ],
        [
            'engine-api.browser-tab.time-limits',
            'no expired end reason',
            edit('GET', /^\/browser-sessions\/[^/]+$/, (data) => ({ ...data, endReason: 'ended' })),
        ],
    ])('%s fails an engine where %s', async (id, _what, tamper) => {
        expect(await outcome(id, { tamper })).toMatchObject({ kind: 'fail' });
    });
});
