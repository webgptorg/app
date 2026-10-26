import { MAX_REGISTRY_HOSTNAMES, type EngineId, type Hostname } from '@ptbk/protocol';

import type { Clock } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { Timer } from '../ports/timer';
import { readReachableRelays } from '../presence/relay-presence';
import type { RelayPresenceStore } from '../presence/relay-presence-store';
import type { EngineRecord } from '../registration/engine-store';
import type { EngineHostnameStore } from '../registry/engine-hostname-store';
import type { EngineStatusSnapshot } from '../status/engine-status';
import type { EngineStatusDirectory } from '../status/engine-status-directory';
import { deriveEngineDisplayStatus, type EngineDisplayStatus } from './engine-display-status';
import { mapConcurrently } from './map-concurrently';

/** Status objects asked at once per request; one Durable Object call per engine. */
export const STATUS_READ_CONCURRENCY = 10;
/** After this an engine shows `unknown` rather than holding up the whole list. */
export const STATUS_READ_TIMEOUT_MS = 2000;

export interface EngineOverviewDeps {
    readonly engineStatus: Pick<EngineStatusDirectory, 'getStatus'>;
    readonly engineHostnames: EngineHostnameStore;
    readonly relayPresence: Pick<RelayPresenceStore, 'reachableRelays'>;
    readonly clock: Clock;
    readonly timer: Timer;
    readonly logger: Logger;
}

/** An engine as the dashboard shows it: the registry row, its heartbeat state, and its active custom hostnames. */
export interface EngineOverview {
    readonly engine: EngineRecord;
    readonly status: EngineDisplayStatus;
    /** Null when the status object did not answer: the engine then shows `unknown`, not an error. */
    readonly snapshot: EngineStatusSnapshot | null;
    readonly customHostnames: readonly Hostname[];
    /** Relays with a ready tunnel for it (R-07); null when no relay report is live, so nothing is known. */
    readonly reachableRelays: number | null;
}

async function readStatus(deps: EngineOverviewDeps, engineId: EngineId): Promise<EngineStatusSnapshot | null> {
    const deadline = new AbortController();
    try {
        const outcome = await Promise.race([
            deps.engineStatus.getStatus(engineId).then((snapshot) => ({ kind: 'answered', snapshot }) as const),
            deps.timer.wait(STATUS_READ_TIMEOUT_MS, deadline.signal).then(() => ({ kind: 'timed-out' }) as const),
        ]);
        if (outcome.kind === 'timed-out') {
            deps.logger.warn('engines.status-timeout', { engineId });
            return null;
        }
        return outcome.snapshot;
    } catch {
        deps.logger.error('engines.status-failed', { engineId });
        return null;
    } finally {
        deadline.abort();
    }
}

async function overviewWithout(
    deps: EngineOverviewDeps,
    engine: EngineRecord,
): Promise<Omit<EngineOverview, 'reachableRelays'>> {
    const [snapshot, claims] = await Promise.all([
        readStatus(deps, engine.engineId),
        deps.engineHostnames.activeCustomHostnames(engine.engineId),
    ]);
    return {
        engine,
        status: deriveEngineDisplayStatus(engine, snapshot),
        snapshot,
        customHostnames: claims.slice(0, MAX_REGISTRY_HOSTNAMES - 1).map((claim) => claim.hostname),
    };
}

/** One engine's overview; the caller read the engine through the organization-scoped store. */
export async function readEngineOverview(deps: EngineOverviewDeps, engine: EngineRecord): Promise<EngineOverview> {
    const [overview, reachable] = await Promise.all([
        overviewWithout(deps, engine),
        readReachableRelays(deps, [engine.engineId]),
    ]);
    return { ...overview, reachableRelays: reachable?.get(engine.engineId) ?? null };
}

/**
 * Overviews of engines the caller already read through the organization-scoped store, so no status object is ever
 * asked about an engine the actor may not see. Presence is one query for the whole list, beside the status reads.
 */
export async function readEngineOverviews(
    deps: EngineOverviewDeps,
    engines: readonly EngineRecord[],
): Promise<readonly EngineOverview[]> {
    const [overviews, reachable] = await Promise.all([
        mapConcurrently(engines, STATUS_READ_CONCURRENCY, (engine) => overviewWithout(deps, engine)),
        readReachableRelays(
            deps,
            engines.map((engine) => engine.engineId),
        ),
    ]);
    return overviews.map((overview) => ({
        ...overview,
        reachableRelays: reachable?.get(overview.engine.engineId) ?? null,
    }));
}
