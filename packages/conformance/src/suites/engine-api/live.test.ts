import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import type { CheckOutcome } from '../../check';
import { runConformance } from '../../runner';
import type { FakeEngineOptions, LiveDefect, Tamper } from '../../testing/fake-engine';
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
