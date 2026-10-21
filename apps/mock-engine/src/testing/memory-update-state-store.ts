import type { UpdateStateStore } from '../domain/ui/update-state-store';
import { MAX_FIRST_SEEN_ENTRIES } from '../domain/ui/update-state-store';

export interface UpdateStateSnapshot {
    readonly firstSeen: ReadonlyMap<string, Date>;
    readonly lastAcceptedRevocationIssuedAt: Date | null;
}

/** In memory; `initial` stands in for state a previous run persisted. */
export function createMemoryUpdateStateStore(initial?: UpdateStateSnapshot): UpdateStateStore & {
    snapshot(): UpdateStateSnapshot;
} {
    const firstSeen = new Map(initial?.firstSeen ?? []);
    let lastAccepted = initial?.lastAcceptedRevocationIssuedAt ?? null;
    return {
        firstSeenAt(key, now) {
            let seen = firstSeen.get(key);
            if (seen === undefined) {
                seen = now;
                firstSeen.set(key, seen);
                for (const oldest of firstSeen.keys()) {
                    if (firstSeen.size <= MAX_FIRST_SEEN_ENTRIES) break;
                    firstSeen.delete(oldest);
                }
            }
            return Promise.resolve(seen);
        },
        lastAcceptedRevocationIssuedAt: () => Promise.resolve(lastAccepted),
        acceptRevocations(issuedAt) {
            if (lastAccepted === null || issuedAt.getTime() > lastAccepted.getTime()) lastAccepted = issuedAt;
            return Promise.resolve();
        },
        snapshot: () => ({ firstSeen: new Map(firstSeen), lastAcceptedRevocationIssuedAt: lastAccepted }),
    };
}
