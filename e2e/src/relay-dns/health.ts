/*
 * The decision rule of the engine domain's health-checked DNS, as the stand-in for Cloudflare's DNS-only load balancer
 * applies it (infra/cloudflare, relay-dns.tf): a relay leaves DNS after `consecutiveDown` failed checks in a row and
 * comes back after `consecutiveUp` passed ones. The DNS answer lists every healthy relay; with none healthy it lists
 * every relay (Cloudflare's fallback pool), so a checker that sees everything fail cannot take every engine offline.
 * Test-only: production runs none of this code.
 */

export interface HealthThresholds {
    readonly consecutiveDown: number;
    readonly consecutiveUp: number;
}

export interface HealthChange<R> {
    readonly relay: R;
    readonly healthy: boolean;
    /** The relays the DNS answer lists after this change, in their configured order. */
    readonly listed: readonly R[];
    /** No relay is healthy, so every relay is listed and someone has to look. */
    readonly fallback: boolean;
}

interface RelayState {
    healthy: boolean;
    streak: number;
}

export interface RelayHealth<R> {
    /** Records one check; returns the change it caused, if any. */
    record(relay: R, passed: boolean): HealthChange<R> | null;
    listed(): readonly R[];
    isFallback(): boolean;
}

/** Every relay starts healthy and listed, as a new load balancer pool does before its first checks. */
export function createRelayHealth<R>(relays: readonly R[], thresholds: HealthThresholds): RelayHealth<R> {
    for (const value of [thresholds.consecutiveDown, thresholds.consecutiveUp]) {
        if (!Number.isInteger(value) || value < 1) throw new Error('thresholds must be positive integers');
    }
    if (relays.length === 0) throw new Error('relay DNS needs at least one relay');
    const states = new Map<R, RelayState>(relays.map((relay) => [relay, { healthy: true, streak: 0 }]));

    const healthyRelays = (): readonly R[] => relays.filter((relay) => states.get(relay)?.healthy === true);
    const listed = (): readonly R[] => {
        const healthy = healthyRelays();
        return healthy.length === 0 ? relays : healthy;
    };

    return {
        record(relay, passed) {
            const state = states.get(relay);
            if (state === undefined) throw new Error('unknown relay');
            // The streak counts checks that disagree with the current state; one agreeing check resets it.
            if (passed === state.healthy) {
                state.streak = 0;
                return null;
            }
            state.streak++;
            if (state.streak < (state.healthy ? thresholds.consecutiveDown : thresholds.consecutiveUp)) return null;
            state.healthy = passed;
            state.streak = 0;
            return { relay, healthy: passed, listed: listed(), fallback: healthyRelays().length === 0 };
        },
        listed,
        isFallback: () => healthyRelays().length === 0,
    };
}
