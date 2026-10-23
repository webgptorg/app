import type { Hostname } from '@ptbk/protocol';

import type { MonitorStore } from '../monitoring/monitor-store';
import type { Logger } from '../ports/logger';
import type { Clock } from '../ports/clock';
import { ABUSE_FEED_BATCH, type AbuseFeed, type ActiveEngineDirectory } from './abuse-feed';

export interface AbuseFeedJobDeps {
    readonly feeds: readonly AbuseFeed[];
    readonly engines: ActiveEngineDirectory;
    readonly monitor: Pick<MonitorStore, 'track'>;
    /** Engines looked up per run; past it the rest wait (logged), until the job pages through them. */
    readonly maxEngines: number;
    readonly timeoutMs: number;
    readonly clock: Clock;
    readonly logger: Logger;
}

async function lookUp(
    deps: AbuseFeedJobDeps,
    feed: AbuseFeed,
    hostnames: readonly Hostname[],
    signal: AbortSignal,
): Promise<ReadonlySet<Hostname> | null> {
    const listed = new Set<Hostname>();
    try {
        for (let index = 0; index < hostnames.length; index += ABUSE_FEED_BATCH) {
            const timeout = AbortSignal.any([signal, AbortSignal.timeout(deps.timeoutMs)]);
            for (const hostname of await feed.listed(hostnames.slice(index, index + ABUSE_FEED_BATCH), timeout)) {
                listed.add(hostname);
            }
        }
        return listed;
    } catch (error) {
        deps.logger.warn('abuse-feed.failed', {
            feed: feed.name,
            problem: error instanceof Error ? error.name : 'unknown',
        });
        return null;
    }
}

/**
 * Abuse feeds (I-05): every active engine's default hostname against every configured feed. An engine any feed lists
 * raises `abuse-feed-listed` to the abuse inbox, once, until no feed lists it; a feed that fails leaves the alerts as
 * they are. Never suspends anything.
 */
export async function runAbuseFeedCheck(deps: AbuseFeedJobDeps, signal: AbortSignal): Promise<void> {
    const at = deps.clock.nowMs();
    const engines = await deps.engines.list(deps.maxEngines + 1);
    if (engines.length > deps.maxEngines) {
        deps.logger.warn('abuse-feed.truncated', { engines: deps.maxEngines });
    }
    const checked = engines.slice(0, deps.maxEngines);
    const hostnames = checked.map((engine) => engine.hostname);
    const results = await Promise.all(deps.feeds.map((feed) => lookUp(deps, feed, hostnames, signal)));
    const answered = results.filter((result): result is ReadonlySet<Hostname> => result !== null);
    if (answered.length === 0 && deps.feeds.length > 0) {
        throw new Error('every abuse feed failed');
    }
    const complete = answered.length === deps.feeds.length;
    await deps.monitor.track(
        'abuse-feed-listed',
        checked.map((engine) => {
            const listings = answered.filter((listed) => listed.has(engine.hostname)).length;
            return {
                subject: engine.engineId,
                firing: listings > 0 ? true : complete ? false : null,
                detail: { feeds: listings },
            };
        }),
        at,
    );
}
