import type { EngineId } from '@ptbk/protocol';

import type { Clock } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { RelayPresenceStore } from './relay-presence-store';

/** Three missed 60-second reports: a relay that went quiet stops counting, and so do the tunnels it reported. */
export const PRESENCE_EXPIRY_MS = 3 * 60 * 1000;

export interface RecordPresenceDeps {
    readonly relayPresence: Pick<RelayPresenceStore, 'replace'>;
    readonly clock: Clock;
    readonly logger: Logger;
    /** `RELAYS`' relay IDs: only a relay engines are told to dial can make them reachable. */
    readonly relayIds: ReadonlySet<string>;
}

export type RecordPresenceOutcome = { readonly kind: 'recorded' } | { readonly kind: 'unknown-relay' };

/** Stores a relay's full report; `relayId` is the authenticated key's, never anything the relay sent. */
export async function recordPresence(
    deps: RecordPresenceDeps,
    relayId: string,
    engineIds: readonly EngineId[],
): Promise<RecordPresenceOutcome> {
    if (!deps.relayIds.has(relayId)) {
        deps.logger.warn('presence.unknown-relay', { relayId });
        return { kind: 'unknown-relay' };
    }
    const now = deps.clock.nowMs();
    await deps.relayPresence.replace(relayId, engineIds, now, now - PRESENCE_EXPIRY_MS);
    return { kind: 'recorded' };
}

export interface ReadPresenceDeps {
    readonly relayPresence: Pick<RelayPresenceStore, 'reachableRelays'>;
    readonly clock: Clock;
    readonly logger: Logger;
}

/**
 * Live relay counts for `engineIds`; every engine is in the map, 0 when no live relay reported it. Null when no relay
 * report is live, or presence could not be read: the dashboard then knows nothing about reachability and says nothing,
 * rather than calling every engine unreachable.
 */
export async function readReachableRelays(
    deps: ReadPresenceDeps,
    engineIds: readonly EngineId[],
): Promise<ReadonlyMap<EngineId, number> | null> {
    let counts: ReadonlyMap<EngineId, number> | null;
    try {
        counts = await deps.relayPresence.reachableRelays(engineIds, deps.clock.nowMs() - PRESENCE_EXPIRY_MS);
    } catch {
        deps.logger.error('presence.read-failed');
        return null;
    }
    return counts === null ? null : new Map(engineIds.map((engineId) => [engineId, counts.get(engineId) ?? 0]));
}
