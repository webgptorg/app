import { createProblem } from '@ptbk/engine-api';
import type { EngineApiClient, EngineApiResponse, ReadEngineEvent } from '@ptbk/engine-api';
import { createInMemoryEngine } from '@ptbk/engine-api/in-memory';
import { describe, expect, it, vi } from 'vitest';

import { createEngineEvents, defaultRetryDelayMs } from './engine-events';

type Stream = EngineApiClient['events']['stream'];
type StreamData = Extract<Awaited<ReturnType<Stream>>, { kind: 'ok' }>['data'];

const changed = (agentId: string): ReadEngineEvent => ({ type: 'agent.changed', agentId }) as ReadEngineEvent;

/** A stream the test feeds by hand: `push` delivers an event, `end` closes the connection. */
function scriptedStream() {
    const connections: {
        lastEventId: string | undefined;
        push: (id: string, event: ReadEngineEvent) => void;
        end: () => void;
    }[] = [];
    const stream = vi.fn<Stream>((options, signal) => {
        const queue: { id: string; event: ReadEngineEvent }[] = [];
        let wake: (() => void) | undefined;
        let ended = false;
        const connection = {
            lastEventId: options.lastEventId,
            push: (id: string, event: ReadEngineEvent) => {
                queue.push({ id, event });
                wake?.();
            },
            end: () => {
                ended = true;
                wake?.();
            },
        };
        connections.push(connection);
        signal.addEventListener('abort', connection.end);
        const data: StreamData = {
            async *[Symbol.asyncIterator]() {
                for (;;) {
                    const next = queue.shift();
                    if (next !== undefined) {
                        yield next;
                        continue;
                    }
                    if (ended) return;
                    await new Promise<void>((resolve) => {
                        wake = resolve;
                    });
                }
            },
        };
        return Promise.resolve({ kind: 'ok', data } as EngineApiResponse<StreamData>);
    });
    return { stream, connections };
}

function manualTimers() {
    const pending: (() => void)[] = [];
    return {
        setTimeout: (callback: () => void) => {
            pending.push(callback);
            return pending.length;
        },
        clearTimeout: vi.fn(),
        runNext: () => pending.shift()?.(),
        get count() {
            return pending.length;
        },
    };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setUp() {
    const { client } = createInMemoryEngine();
    const scripted = scriptedStream();
    const timers = manualTimers();
    const engineApi = { ...client, events: { stream: scripted.stream } };
    const events = createEngineEvents({ engineApi, retryDelayMs: () => 1, ...timers });
    return { events, timers, ...scripted };
}

describe('engine events', () => {
    it('shares one connection between subscribers and delivers each event to all of them', async () => {
        const { events, stream, connections } = setUp();
        const first = vi.fn();
        const second = vi.fn();
        events.subscribe({ onEvent: first });
        events.subscribe({ onEvent: second });
        await flush();
        connections[0]?.push('1', changed('a1'));
        await flush();

        expect(stream).toHaveBeenCalledOnce();
        expect(first).toHaveBeenCalledWith(changed('a1'));
        expect(second).toHaveBeenCalledWith(changed('a1'));
    });

    it('reconnects after a drop, resumes after the last event and tells subscribers to refetch', async () => {
        const { events, timers, connections } = setUp();
        const onReconnect = vi.fn();
        events.subscribe({ onEvent: () => undefined, onReconnect });
        await flush();
        connections[0]?.push('7', changed('a1'));
        await flush();
        connections[0]?.end();
        await flush();
        expect(onReconnect).not.toHaveBeenCalled();

        timers.runNext();
        await flush();
        expect(connections[1]?.lastEventId).toBe('7');
        expect(onReconnect).toHaveBeenCalledOnce();
    });

    it('backs off a stream that keeps closing without events, and starts over once one delivers', async () => {
        const { client } = createInMemoryEngine();
        const { stream, connections } = scriptedStream();
        const timers = manualTimers();
        const retryDelayMs = vi.fn((attempt: number) => attempt);
        const events = createEngineEvents({ engineApi: { ...client, events: { stream } }, retryDelayMs, ...timers });
        events.subscribe({ onEvent: () => undefined });
        await flush();
        connections[0]?.end();
        await flush();
        timers.runNext();
        await flush();
        connections[1]?.end();
        await flush();
        timers.runNext();
        await flush();
        connections[2]?.push('1', changed('a1'));
        connections[2]?.end();
        await flush();

        expect(retryDelayMs.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 1]);
    });

    it('disconnects when the last subscriber leaves and resumes when one comes back', async () => {
        const { events, connections, stream } = setUp();
        const onReconnect = vi.fn();
        const unsubscribe = events.subscribe({ onEvent: () => undefined, onReconnect });
        await flush();
        connections[0]?.push('3', changed('a1'));
        await flush();
        unsubscribe();
        unsubscribe();
        await flush();

        events.subscribe({ onEvent: () => undefined, onReconnect });
        await flush();
        expect(stream).toHaveBeenCalledTimes(2);
        expect(connections[1]?.lastEventId).toBe('3');
        expect(onReconnect).toHaveBeenCalledOnce();
    });

    it('retries a server error but gives up on a refusal it would only repeat', async () => {
        const { client } = createInMemoryEngine();
        const timers = manualTimers();
        const stream = vi
            .fn<Stream>()
            .mockResolvedValueOnce({ kind: 'problem', problem: createProblem('internal-error') })
            .mockResolvedValue({ kind: 'problem', problem: createProblem('forbidden') });
        const events = createEngineEvents({ engineApi: { ...client, events: { stream } }, ...timers });
        const unsubscribe = events.subscribe({ onEvent: () => undefined });
        await flush();
        expect(timers.count).toBe(1);
        timers.runNext();
        await flush();
        expect(stream).toHaveBeenCalledTimes(2);
        expect(timers.count).toBe(0);

        unsubscribe();
        events.subscribe({ onEvent: () => undefined });
        await flush();
        expect(stream).toHaveBeenCalledTimes(2);
    });

    it('retries when the connection cannot be opened, and cancels the retry when nobody listens', async () => {
        const { client } = createInMemoryEngine();
        const timers = manualTimers();
        const stream = vi.fn<Stream>().mockRejectedValue(new TypeError('offline'));
        const events = createEngineEvents({ engineApi: { ...client, events: { stream } }, ...timers });
        const unsubscribe = events.subscribe({ onEvent: () => undefined });
        await flush();
        expect(timers.count).toBe(1);
        unsubscribe();
        expect(timers.clearTimeout).toHaveBeenCalledOnce();
    });

    it('keeps delivering to everyone when one subscriber throws', async () => {
        const { client } = createInMemoryEngine();
        const { stream, connections } = scriptedStream();
        const reportError = vi.fn();
        const events = createEngineEvents({ engineApi: { ...client, events: { stream } }, reportError });
        const healthy = vi.fn();
        events.subscribe({
            onEvent: () => {
                throw new Error('subscriber bug');
            },
        });
        events.subscribe({ onEvent: healthy });
        await flush();
        connections[0]?.push('1', changed('a1'));
        connections[0]?.push('2', changed('a2'));
        await flush();

        expect(healthy).toHaveBeenCalledTimes(2);
        expect(reportError).toHaveBeenCalledTimes(2);
    });

    it('streams real engine events from the in-memory engine', async () => {
        const { client, controller } = createInMemoryEngine();
        const events = createEngineEvents({ engineApi: client });
        const onEvent = vi.fn();
        const unsubscribe = events.subscribe({ onEvent });
        await flush();
        controller.emit({ type: 'agent.changed', agentId: 'agent-1' });
        await vi.waitFor(() => {
            expect(onEvent).toHaveBeenCalledWith({ type: 'agent.changed', agentId: 'agent-1' });
        });
        unsubscribe();
    });

    it('backs off up to half a minute', () => {
        expect([1, 2, 3, 10].map(defaultRetryDelayMs)).toEqual([1_000, 2_000, 4_000, 30_000]);
    });
});
