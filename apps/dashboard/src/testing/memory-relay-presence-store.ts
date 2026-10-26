import type { EngineId } from '@ptbk/protocol';

import type { RelayPresenceStore } from '../domain/presence/relay-presence-store';

export interface MemoryRelayPresenceStore extends RelayPresenceStore {
    /** Each relay's last report, as the D1 tables hold it. */
    readonly reports: ReadonlyMap<string, { readonly reportedAt: number; readonly engineIds: ReadonlySet<EngineId> }>;
}

/** The D1 store's rules in memory. */
export function createMemoryRelayPresenceStore(): MemoryRelayPresenceStore {
    const reports = new Map<string, { readonly reportedAt: number; readonly engineIds: ReadonlySet<EngineId> }>();
    return {
        reports,
        replace(relayId, engineIds, reportedAt, expiredAt) {
            for (const [other, report] of reports) {
                if (other !== relayId && report.reportedAt <= expiredAt) {
                    reports.delete(other);
                }
            }
            reports.set(relayId, { reportedAt, engineIds: new Set(engineIds) });
            return Promise.resolve();
        },
        reachableRelays(engineIds, liveAfter) {
            const live = [...reports.values()].filter((report) => report.reportedAt > liveAfter);
            if (live.length === 0) {
                return Promise.resolve(null);
            }
            const counts = new Map<EngineId, number>();
            for (const engineId of engineIds) {
                const relays = live.filter((report) => report.engineIds.has(engineId)).length;
                if (relays > 0) {
                    counts.set(engineId, relays);
                }
            }
            return Promise.resolve(counts);
        },
    };
}
