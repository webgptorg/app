import type { EngineId } from '@ptbk/protocol';

/**
 * Which relays hold a ready tunnel for which engines (R-07): each relay's last full list and when it reported it.
 * Nothing else, and no history: a report replaces the relay's previous one.
 */
export interface RelayPresenceStore {
    /**
     * Replaces `relayId`'s list with `engineIds`, reported at `reportedAt`, and forgets every other relay whose last
     * report is at or before `expiredAt`.
     */
    replace(relayId: string, engineIds: readonly EngineId[], reportedAt: number, expiredAt: number): Promise<void>;
    /**
     * How many relays reported each of `engineIds` after `liveAfter` (engines no relay reported are absent), or null
     * when no relay has reported after `liveAfter` at all.
     */
    reachableRelays(engineIds: readonly EngineId[], liveAfter: number): Promise<ReadonlyMap<EngineId, number> | null>;
}
