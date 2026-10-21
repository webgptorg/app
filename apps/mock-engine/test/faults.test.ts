import { afterEach, describe, expect, it } from 'vitest';

import type { FaultPlan } from '../src/domain/faults/fault-plan';
import { FaultPlan as FaultPlanSchema } from '../src/domain/faults/fault-plan';
import type { ApiHarness } from '../src/testing/api-harness';
import { HARNESS_ORIGIN, createApiHarness } from '../src/testing/api-harness';
import { HANDSHAKE_TIMEOUT_MS } from '../src/adapters/tls-stream-server';
import type { FakeClock } from '../src/testing/fake-clock';
import { createFakeClock } from '../src/testing/fake-clock';

let harness: ApiHarness | undefined;
afterEach(async () => {
    await harness?.close();
    harness = undefined;
});

const ALLOW_ALL = { consume: () => ({ kind: 'allowed' as const }) };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const api = (path: string) => `${HARNESS_ORIGIN}/api/v1${path}`;

async function start(faults: Partial<FaultPlan>, clock?: FakeClock) {
    harness = await createApiHarness({
        faults: FaultPlanSchema.parse(faults),
        rateLimiter: ALLOW_ALL,
        ...(clock === undefined ? {} : { clock }),
    });
    return { engine: harness, fetch: harness.fetch(harness.signIn({ memberId: harness.ownerId() })) };
}

/** Steps the fake clock until `pending` settles; resolves with how much fake time that took. */
async function timeOf<T>(clock: FakeClock, pending: Promise<T>, stepMs = 10): Promise<{ value: T; elapsedMs: number }> {
    const startMs = clock.nowMs();
    const state = { settled: false };
    const result = pending.then((value) => {
        state.settled = true;
        return value;
    });
    const settled = (): boolean => state.settled;
    for (let step = 0; step < 10_000 && !settled(); step++) {
        await tick();
        if (!settled()) clock.advance(stepMs);
    }
    const value = await result;
    return { value, elapsedMs: clock.nowMs() - startMs };
}

describe('fault injection', () => {
    it('delays responses by a latency within the plan bounds', async () => {
        const clock = createFakeClock(Date.now());
        // Records each delay the server schedules, so the test advances fake time exactly that far, however slow the
        // machine is.
        const delays: number[] = [];
        const recording = {
            nowMs: () => clock.nowMs(),
            setTimeout(fn: () => void, ms: number) {
                // The ClientHello router's handshake timeout is not a response delay.
                if (ms <= 60_000 && ms !== HANDSHAKE_TIMEOUT_MS) delays.push(ms);
                return clock.setTimeout(fn, ms);
            },
        };
        const { fetch } = await start({ latencyMs: { min: 200, max: 400 } }, { ...clock, ...recording });
        for (let request = 0; request < 10; request++) {
            const before = delays.length;
            let done = false;
            const pending = fetch(api('/me')).then((response) => {
                done = true;
                return response;
            });
            for (let wait = 0; delays.length === before && wait < 10_000; wait++) await tick();
            const delay = delays.at(-1) ?? 0;
            expect(delay).toBeGreaterThanOrEqual(200);
            expect(delay).toBeLessThanOrEqual(400);
            clock.advance(delay - 1);
            for (let wait = 0; wait < 20; wait++) await tick();
            expect(done).toBe(false);
            clock.advance(1);
            expect((await pending).status).toBe(200);
        }
        expect(new Set(delays).size).toBeGreaterThan(1);
    });

    it('fails requests at the planned rate, reproducibly for the seed', async () => {
        const { fetch, engine } = await start({ errorRate: 0.3, errorStatus: 503 });
        let failed = 0;
        const statuses: number[] = [];
        for (let request = 0; request < 1_000; request++) {
            const response = await fetch(api('/me'));
            statuses.push(response.status);
            if (response.status === 503) {
                expect(await response.json()).toMatchObject({ status: 503, code: 'unavailable' });
                failed++;
            } else {
                expect(response.status).toBe(200);
                await response.arrayBuffer();
            }
        }
        expect(failed / 1_000).toBeGreaterThan(0.25);
        expect(failed / 1_000).toBeLessThan(0.35);
        expect(engine.recorder.violations).toEqual([]);
        await engine.close();
        const again = await start({ errorRate: 0.3, errorStatus: 503 });
        const replay: number[] = [];
        for (let request = 0; request < 50; request++) replay.push((await again.fetch(api('/me'))).status);
        expect(replay).toEqual(statuses.slice(0, 50));
    }, 60_000);

    it.each([
        [500, 'internal-error'],
        [502, 'reply-failed'],
        [503, 'unavailable'],
    ] as const)('answers an injected %i as problem+json %s', async (status, code) => {
        const { fetch, engine } = await start({ errorRate: 1, errorStatus: status });
        const response = await fetch(api('/agents'));
        expect(response.status).toBe(status);
        expect(response.headers.get('content-type')).toBe('application/problem+json');
        expect(await response.json()).toMatchObject({ status, code });
        expect(engine.recorder.violations).toEqual([]);
    });

    it('never injects into what the routes filter leaves out', async () => {
        const { fetch } = await start({ errorRate: 1, routes: ['/api/v1/agents', '/api/v1/chats/**'] });
        expect((await fetch(api('/agents'))).status).toBe(503);
        expect((await fetch(api('/chats/chat-1/messages'))).status).toBe(503);
        expect((await fetch(api('/me'))).status).toBe(200);
        expect((await fetch(api('/agents/agent-1'))).status).not.toBe(503);
    });

    it('cuts an event stream after a few events, as a dying connection would', async () => {
        const { fetch, engine } = await start({ dropStreamRate: 1 });
        const response = await fetch(api('/events'));
        expect(response.status).toBe(200);
        const reader = response.body?.getReader();
        if (reader === undefined) throw new Error('no body');
        const pump = (async () => {
            const text: string[] = [];
            for (;;) {
                const next = await reader.read();
                if (next.done) return { ended: 'cleanly', text: text.join('') };
                text.push(new TextDecoder().decode(next.value));
            }
        })().catch((error: unknown) => ({ ended: 'with an error', error }));
        for (let event = 0; event < 25; event++) {
            engine.core().controller.emit({ type: 'agent.changed', agentId: `agent-${String(event)}` });
            await tick();
        }
        const outcome = await pump;
        expect(outcome.ended).toBe('with an error');
    });

    it('changes on the next request through the control listener', async () => {
        const { fetch, engine } = await start({});
        const control = await engine.startControl();
        const url = `http://127.0.0.1:${String(control.port)}/__mock/faults`;
        expect((await fetch(api('/me'))).status).toBe(200);
        const put = await globalThis.fetch(url, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ errorRate: 1, errorStatus: 500 }),
        });
        expect(put.status).toBe(200);
        expect((await fetch(api('/me'))).status).toBe(500);
        expect((await globalThis.fetch(url, { method: 'DELETE' })).status).toBe(204);
        expect((await fetch(api('/me'))).status).toBe(200);
        const invalid = await globalThis.fetch(url, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ errorRate: 2 }),
        });
        expect(invalid.status).toBe(400);
    });

    it('slows the tunnel to the planned bytes per second', async () => {
        const clock = createFakeClock(Date.now());
        const { fetch } = await start({ slowTunnelBytesPerS: 20_000 }, clock);
        const bytes = 60_000;
        const { value, elapsedMs } = await timeOf(
            clock,
            fetch(`${HARNESS_ORIGIN}/__spike/download?bytes=${String(bytes)}`).then(async (response) => ({
                status: response.status,
                length: (await response.arrayBuffer()).byteLength,
            })),
            50,
        );
        expect(value).toEqual({ status: 200, length: bytes });
        expect(elapsedMs).toBeGreaterThanOrEqual((bytes / 20_000) * 1000);
    });
});
