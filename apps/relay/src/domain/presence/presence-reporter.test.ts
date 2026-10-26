import type { EngineId } from '@ptbk/protocol';
import { EngineId as EngineIdSchema } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import type { TestDeps } from '../../testing/test-deps';
import { createTestDeps } from '../../testing/test-deps';
import type { PresenceOutcome, PresenceReporter, PresenceSink } from './presence-reporter';
import {
    MAX_PRESENCE_ENGINE_IDS,
    PRESENCE_DEBOUNCE_MS,
    PRESENCE_INTERVAL_MS,
    createPresenceReporter,
} from './presence-reporter';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function engineId(n: number): EngineId {
    let id = '';
    for (let rest = n, i = 0; i < 26; i++, rest = Math.floor(rest / 32)) id = (BASE32[rest % 32] ?? 'a') + id;
    return EngineIdSchema.parse(id);
}

const A = engineId(1);
const B = engineId(2);
const C = engineId(3);

interface Call {
    readonly engineIds: readonly EngineId[];
    readonly signal: AbortSignal;
    resolve(outcome: PresenceOutcome): void;
    reject(error: Error): void;
}

interface FakeSink extends PresenceSink {
    readonly calls: Call[];
}

function createFakeSink(): FakeSink {
    const calls: Call[] = [];
    return {
        calls,
        report(engineIds, signal) {
            return new Promise((resolve, reject) => {
                calls.push({ engineIds, signal, resolve, reject });
            });
        },
    };
}

/** Lets the sink's settled promise reach the reporter. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('createPresenceReporter', () => {
    let clock: TestDeps['clock'];
    let logger: TestDeps['logger'];
    let sink: FakeSink;
    let connected: EngineId[];
    let reporter: PresenceReporter;

    beforeEach(() => {
        ({ clock, logger } = createTestDeps());
        sink = createFakeSink();
        connected = [];
        reporter = createPresenceReporter({ clock, sink, logger, engineIds: () => connected });
    });

    async function answer(outcome: PresenceOutcome = { kind: 'accepted' }): Promise<void> {
        sink.calls.at(-1)?.resolve(outcome);
        await flush();
    }

    it('sends its first report one debounce after start, then the full list every interval', async () => {
        connected = [B, A];
        reporter.start();
        reporter.start();
        clock.advance(PRESENCE_DEBOUNCE_MS - 1);
        expect(sink.calls).toHaveLength(0);
        clock.advance(1);
        expect(sink.calls.map((call) => call.engineIds)).toEqual([[A, B]]);
        await answer();
        clock.advance(PRESENCE_INTERVAL_MS - 1);
        expect(sink.calls).toHaveLength(1);
        clock.advance(1);
        expect(sink.calls.map((call) => call.engineIds)).toEqual([
            [A, B],
            [A, B],
        ]);
        expect(logger.entries).toEqual([]);
    });

    it('reports within one debounce of the first change, however long the churn goes on', async () => {
        reporter.start();
        clock.advance(PRESENCE_DEBOUNCE_MS);
        await answer();
        connected = [A];
        reporter.changed();
        clock.advance(2000);
        connected = [A, C];
        reporter.changed();
        clock.advance(2000);
        connected = [C];
        reporter.changed();
        clock.advance(PRESENCE_DEBOUNCE_MS - 4000);
        expect(sink.calls.map((call) => call.engineIds)).toEqual([[], [C]]);
    });

    it('sends the full list, not a delta, and moves the next periodic report after a debounced one', async () => {
        connected = [A, B];
        reporter.start();
        clock.advance(PRESENCE_DEBOUNCE_MS);
        await answer();
        clock.advance(30_000);
        connected = [A, B, C];
        reporter.changed();
        clock.advance(PRESENCE_DEBOUNCE_MS);
        await answer();
        clock.advance(PRESENCE_INTERVAL_MS - 1);
        expect(sink.calls).toHaveLength(2);
        clock.advance(1);
        expect(sink.calls.map((call) => call.engineIds)).toEqual([
            [A, B],
            [A, B, C],
            [A, B, C],
        ]);
    });

    it('logs a failed report with its status only and retries at the next tick', async () => {
        connected = [A];
        reporter.start();
        clock.advance(PRESENCE_DEBOUNCE_MS);
        await answer({ kind: 'failed', status: 503 });
        clock.advance(PRESENCE_INTERVAL_MS);
        await answer({ kind: 'failed', status: 'timeout' });
        clock.advance(PRESENCE_INTERVAL_MS);
        sink.calls.at(-1)?.reject(new Error('sink broke'));
        await flush();
        clock.advance(PRESENCE_INTERVAL_MS);
        expect(sink.calls).toHaveLength(4);
        expect(logger.entries).toEqual([
            { level: 'warn', event: 'presence.report-failed', fields: { status: 503 } },
            { level: 'warn', event: 'presence.report-failed', fields: { status: 'timeout' } },
            { level: 'warn', event: 'presence.report-failed', fields: { status: 'network' } },
        ]);
    });

    it('sends again one debounce after a report that was in flight when a tunnel changed', async () => {
        connected = [A];
        reporter.start();
        clock.advance(PRESENCE_DEBOUNCE_MS);
        connected = [A, B];
        reporter.changed();
        clock.advance(PRESENCE_DEBOUNCE_MS);
        expect(sink.calls).toHaveLength(1);
        await answer();
        clock.advance(PRESENCE_DEBOUNCE_MS);
        expect(sink.calls.map((call) => call.engineIds)).toEqual([[A], [A, B]]);
    });

    it('sends at most the dashboard cap and logs the counts', () => {
        connected = Array.from({ length: MAX_PRESENCE_ENGINE_IDS + 2 }, (_, index) => engineId(index));
        reporter.start();
        clock.advance(PRESENCE_DEBOUNCE_MS);
        expect(sink.calls[0]?.engineIds).toEqual([...connected].sort().slice(0, MAX_PRESENCE_ENGINE_IDS));
        expect(logger.entries).toEqual([
            {
                level: 'warn',
                event: 'presence.truncated',
                fields: { engines: MAX_PRESENCE_ENGINE_IDS + 2, cap: MAX_PRESENCE_ENGINE_IDS },
            },
        ]);
    });

    it('does nothing before start and after stop, and aborts the report in flight', async () => {
        reporter.changed();
        reporter.stop();
        clock.advance(PRESENCE_INTERVAL_MS);
        expect(sink.calls).toHaveLength(0);
        reporter.start();
        clock.advance(PRESENCE_DEBOUNCE_MS);
        const [inFlight] = sink.calls;
        reporter.stop();
        expect(inFlight?.signal.aborted).toBe(true);
        await answer({ kind: 'failed', status: 'network' });
        reporter.changed();
        clock.advance(PRESENCE_INTERVAL_MS * 3);
        expect(sink.calls).toHaveLength(1);
        expect(logger.entries).toEqual([]);
        expect(clock.pendingTimers()).toBe(0);
    });

    it('starts one fresh chain after a restart, whatever the old report does', async () => {
        reporter.start();
        clock.advance(PRESENCE_DEBOUNCE_MS);
        const [old] = sink.calls;
        reporter.stop();
        reporter.start();
        clock.advance(PRESENCE_DEBOUNCE_MS);
        expect(sink.calls).toHaveLength(2);
        old?.resolve({ kind: 'accepted' });
        await answer();
        expect(clock.pendingTimers()).toBe(1);
        clock.advance(PRESENCE_INTERVAL_MS);
        expect(sink.calls).toHaveLength(3);
    });
});
