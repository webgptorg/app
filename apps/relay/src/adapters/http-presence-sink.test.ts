import type { EngineId } from '@ptbk/protocol';
import { EngineId as EngineIdSchema } from '@ptbk/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FakeDashboard } from '../testing/fake-dashboard';
import { TEST_RELAY_TOKEN, startFakeDashboard } from '../testing/fake-dashboard';
import { createTestDeps } from '../testing/test-deps';
import type { TestDeps } from '../testing/test-deps';
import type { RegistryFetch } from './http-engine-registry';
import { PRESENCE_PATH, createHttpPresenceSink } from './http-presence-sink';
import { systemClock } from './system-clock';

const TIMEOUT_MS = 3000;
const A: EngineId = EngineIdSchema.parse('a'.repeat(26));
const B: EngineId = EngineIdSchema.parse('b'.repeat(26));

describe('createHttpPresenceSink against the dashboard over HTTP', () => {
    let deps: TestDeps;
    let dashboard: FakeDashboard;

    beforeEach(async () => {
        deps = createTestDeps();
        dashboard = await startFakeDashboard(deps.registry);
    });

    afterEach(async () => {
        await dashboard.close();
    });

    const sink = (token = TEST_RELAY_TOKEN) =>
        createHttpPresenceSink({
            fetch: (url, init) => fetch(url, init),
            clock: systemClock,
            config: { url: `${dashboard.url}//`, token: { reveal: () => token }, timeoutMs: TIMEOUT_MS },
        });

    it('puts the list as compact JSON with the relay key, and takes 204 as accepted', async () => {
        const signal = new AbortController().signal;
        expect(await sink().report([A, B], signal)).toEqual({ kind: 'accepted' });
        expect(await sink().report([], signal)).toEqual({ kind: 'accepted' });
        expect(dashboard.presence).toEqual([
            {
                authorization: `Bearer ${TEST_RELAY_TOKEN}`,
                contentType: 'application/json',
                text: `{"v":1,"engineIds":["${A}","${B}"]}`,
            },
            {
                authorization: `Bearer ${TEST_RELAY_TOKEN}`,
                contentType: 'application/json',
                text: '{"v":1,"engineIds":[]}',
            },
        ]);
        expect(dashboard.requests()).toBe(0);
    });

    it('reports any other status as a failure with that status', async () => {
        const signal = new AbortController().signal;
        expect(await sink(`ptbk_rt_${'B'.repeat(43)}`).report([A], signal)).toEqual({ kind: 'failed', status: 401 });
        dashboard.setPresenceStatus(500);
        expect(await sink().report([A], signal)).toEqual({ kind: 'failed', status: 500 });
        dashboard.setPresenceStatus(200);
        expect(await sink().report([A], signal)).toEqual({ kind: 'failed', status: 200 });
    });
});

describe('createHttpPresenceSink failures', () => {
    const signal = new AbortController().signal;

    function withFetch(fetch: RegistryFetch, deps: TestDeps = createTestDeps()) {
        return createHttpPresenceSink({
            fetch,
            clock: deps.clock,
            config: { url: 'https://app.ptbk.test', token: { reveal: () => TEST_RELAY_TOKEN }, timeoutMs: TIMEOUT_MS },
        });
    }

    it('sends PUT to the presence path and never follows a redirect', async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        const outcome = await withFetch((url, init) => {
            calls.push({ url, init });
            return Promise.resolve(new Response('ignored', { status: 302 }));
        }).report([A], signal);
        expect(outcome).toEqual({ kind: 'failed', status: 302 });
        expect(calls[0]?.url).toBe(`https://app.ptbk.test${PRESENCE_PATH}`);
        expect(calls[0]?.init).toMatchObject({ method: 'PUT', redirect: 'error' });
    });

    it('reports a network error and a timeout without throwing', async () => {
        expect(await withFetch(() => Promise.reject(new TypeError('fetch failed'))).report([A], signal)).toEqual({
            kind: 'failed',
            status: 'network',
        });
        const deps = createTestDeps();
        const hanging = withFetch(
            (_url, init) =>
                new Promise((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => {
                        reject(init.signal?.reason as Error);
                    });
                }),
            deps,
        ).report([A], signal);
        deps.clock.advance(TIMEOUT_MS);
        expect(await hanging).toEqual({ kind: 'failed', status: 'timeout' });
        expect(deps.clock.pendingTimers()).toBe(0);
    });

    it('aborts the request when the caller does', async () => {
        const caller = new AbortController();
        const deps = createTestDeps();
        let seen: AbortSignal | undefined;
        const pending = withFetch((_url, init) => {
            seen = init.signal ?? undefined;
            return new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => {
                    reject(init.signal?.reason as Error);
                });
            });
        }, deps).report([A], caller.signal);
        caller.abort(new DOMException('relay stopping', 'AbortError'));
        expect(await pending).toEqual({ kind: 'failed', status: 'network' });
        expect(seen?.aborted).toBe(true);
        expect(deps.clock.pendingTimers()).toBe(0);
    });
});
