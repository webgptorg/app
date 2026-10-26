import { Hostname, type EngineId } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { createFakeAbuseFeed, type FakeAbuseFeed } from '../../testing/fake-abuse-feed';
import { createMemoryMonitor, createMonitoringTestDeps, type MonitoringTestDeps } from '../../testing/test-monitoring';
import { ABUSE_FEED_BATCH, type ActiveEngine } from './abuse-feed';
import { runAbuseFeedCheck, type AbuseFeedJobDeps } from './abuse-feed-job';

const NOW = Date.UTC(2026, 9, 23, 12);
const signal = new AbortController().signal;

function engine(index: number): ActiveEngine {
    // Base32 has no 0, 1, 8 or 9: spell the index's digits as letters.
    const engineId = String(index)
        .padStart(26, 'a')
        .replace(/[0-9]/g, (digit) => String.fromCharCode(98 + Number(digit)));
    return { engineId: engineId as EngineId, hostname: Hostname.parse(`${engineId}.engines.ptbk.test`) };
}

describe('runAbuseFeedCheck', () => {
    let test: MonitoringTestDeps;
    let first: FakeAbuseFeed;
    let second: FakeAbuseFeed;
    let monitor: ReturnType<typeof createMemoryMonitor>;
    let engines: ActiveEngine[];
    let deps: AbuseFeedJobDeps;

    beforeEach(() => {
        test = createMonitoringTestDeps(NOW);
        first = createFakeAbuseFeed('first');
        second = createFakeAbuseFeed('second');
        monitor = createMemoryMonitor();
        engines = [engine(1), engine(2)];
        deps = {
            feeds: [first, second],
            engines: { list: (limit) => Promise.resolve(engines.slice(0, limit)) },
            monitor,
            maxEngines: 1000,
            timeoutMs: 50,
            clock: test.clock,
            logger: test.logger,
        };
    });

    it('alerts the abuse inbox once while a feed lists an engine, and resolves when none does', async () => {
        const [listed] = engines as [ActiveEngine];
        first.listing.add(listed.hostname);
        second.listing.add(listed.hostname);
        await runAbuseFeedCheck(deps, signal);
        await runAbuseFeedCheck(deps, signal);
        first.listing.clear();
        second.listing.clear();
        await runAbuseFeedCheck(deps, signal);
        expect(await monitor.alerts()).toEqual([
            { rule: 'abuse-feed-listed', subject: listed.engineId, state: 'firing', at: NOW, detail: { feeds: 2 } },
            { rule: 'abuse-feed-listed', subject: listed.engineId, state: 'resolved', at: NOW, detail: { feeds: 0 } },
        ]);
    });

    it('keeps an alert open while a feed that could clear it fails, and fails when every feed does', async () => {
        const [listed] = engines as [ActiveEngine];
        first.listing.add(listed.hostname);
        await runAbuseFeedCheck(deps, signal);
        first.listing.clear();
        second.fail = new TypeError('fetch failed');
        await runAbuseFeedCheck(deps, signal);
        expect((await monitor.alerts()).map((alert) => alert.state)).toEqual(['firing']);
        expect(test.logger.entries).toContainEqual({
            level: 'warn',
            event: 'abuse-feed.failed',
            fields: { feed: 'second', problem: 'TypeError' },
        });
        first.fail = 'nope' as unknown as Error;
        await expect(runAbuseFeedCheck(deps, signal)).rejects.toThrow('every abuse feed failed');
    });

    it('asks in batches and looks up at most maxEngines per run', async () => {
        engines = Array.from({ length: ABUSE_FEED_BATCH + 3 }, (_, index) => engine(index));
        await runAbuseFeedCheck({ ...deps, maxEngines: ABUSE_FEED_BATCH + 2 }, signal);
        expect(first.batches).toEqual([ABUSE_FEED_BATCH, 2]);
        expect(test.logger.entries).toContainEqual({
            level: 'warn',
            event: 'abuse-feed.truncated',
            fields: { engines: ABUSE_FEED_BATCH + 2 },
        });
        await runAbuseFeedCheck({ ...deps, feeds: [] }, signal);
    });
});
