import { describe, expect, it } from 'vitest';

import type { FaultDecision } from '../../domain/faults/fault-injector';
import { createFakeClock } from '../../testing/fake-clock';
import { withFaults } from './fault-middleware';

const NONE: FaultDecision = { latencyMs: 0, error: null, dropStreamAfterEvents: null };

function faultsWith(decision: Partial<FaultDecision>) {
    const clock = createFakeClock(1_000);
    const decided: string[] = [];
    return {
        clock,
        decided,
        faults: {
            clock,
            injector: {
                decide: (path: string) => {
                    decided.push(path);
                    return { ...NONE, ...decision };
                },
            },
        },
    };
}

function sse(events: number, end = true): Response {
    const encoder = new TextEncoder();
    let sent = 0;
    return new Response(
        new ReadableStream<Uint8Array>({
            pull(controller) {
                if (sent === events) {
                    if (end) controller.close();
                    return;
                }
                sent++;
                controller.enqueue(encoder.encode(`id: ${String(sent)}\ndata: {}\n\n`));
            },
        }),
        { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
    );
}

async function readAll(response: Response): Promise<{ readonly text: string; readonly error: boolean }> {
    try {
        return { text: await response.text(), error: false };
    } catch {
        return { text: '', error: true };
    }
}

describe('withFaults', () => {
    it('waits out the latency on the clock before running the route', async () => {
        const { clock, faults, decided } = faultsWith({ latencyMs: 250 });
        let ran = false;
        const pending = withFaults(faults, '/api/v1/me', new AbortController().signal, () => {
            ran = true;
            return Promise.resolve(new Response('ok'));
        });
        clock.advance(249);
        await Promise.resolve();
        expect(ran).toBe(false);
        clock.advance(1);
        expect(await (await pending).text()).toBe('ok');
        expect(decided).toEqual(['/api/v1/me']);
    });

    it('gives up waiting when the client goes away', async () => {
        const { clock, faults } = faultsWith({ latencyMs: 1_000 });
        const client = new AbortController();
        const pending = withFaults(faults, '/x', client.signal, () => Promise.resolve(new Response('ok')));
        client.abort(new Error('gone'));
        await expect(pending).rejects.toThrow('gone');
        expect(clock.pendingTimers()).toBe(0);
        await expect(
            withFaults(faults, '/x', AbortSignal.abort(new Error('already gone')), () =>
                Promise.resolve(new Response('ok')),
            ),
        ).rejects.toThrow('already gone');
    });

    it('answers an injected error instead of the route', async () => {
        const { faults } = faultsWith({ error: 502 });
        let ran = false;
        const response = await withFaults(faults, '/x', new AbortController().signal, () => {
            ran = true;
            return Promise.resolve(new Response('ok'));
        });
        expect(ran).toBe(false);
        expect(response.status).toBe(502);
        expect(response.headers.get('content-type')).toBe('application/problem+json');
        expect(await response.json()).toMatchObject({ code: 'reply-failed', status: 502 });
    });

    it('cuts an event stream after its N-th event and leaves other bodies alone', async () => {
        const { faults } = faultsWith({ dropStreamAfterEvents: 3 });
        const cut = await withFaults(faults, '/x', new AbortController().signal, () => Promise.resolve(sse(10, false)));
        expect(await readAll(cut)).toEqual({ text: '', error: true });
        const reader = (
            await withFaults(faults, '/x', new AbortController().signal, () => Promise.resolve(sse(10)))
        ).body?.getReader();
        const seen: string[] = [];
        await expect(
            (async () => {
                for (;;) {
                    const next = await reader?.read();
                    if (next?.done !== false) return;
                    seen.push(new TextDecoder().decode(next.value));
                }
            })(),
        ).rejects.toThrow('fault: stream dropped');
        expect(seen).toHaveLength(3);
        const short = await withFaults(faults, '/x', new AbortController().signal, () => Promise.resolve(sse(2)));
        expect(await readAll(short)).toMatchObject({ error: false });
        const json = await withFaults(faults, '/x', new AbortController().signal, () =>
            Promise.resolve(Response.json({ a: 1 })),
        );
        expect(await json.json()).toEqual({ a: 1 });
    });

    it('passes a cancel through to the original stream', async () => {
        const { faults } = faultsWith({ dropStreamAfterEvents: 5 });
        let cancelled: unknown = null;
        const source = new Response(
            new ReadableStream<Uint8Array>({
                pull() {
                    // Never produces: the reader cancels first.
                },
                cancel(reason) {
                    cancelled = reason;
                },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
        );
        const wrapped = await withFaults(faults, '/x', new AbortController().signal, () => Promise.resolve(source));
        await wrapped.body?.cancel('done');
        expect(cancelled).toBe('done');
    });
});
