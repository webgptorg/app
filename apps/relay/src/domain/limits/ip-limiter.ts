import type { Clock } from '../clock';
import { ipLimitKey } from '../ip-address';
import type { TokenBucket } from './token-bucket';
import { createTokenBucket } from './token-bucket';

export interface IpLimits {
    /** `RELAY_MAX_CONNECTIONS`: open connections on the listener, relay-wide. */
    readonly maxConnections: number;
    /** `RELAY_MAX_CONNECTIONS_PER_IP`. */
    readonly maxConnectionsPerIp: number;
    /** `RELAY_NEW_CONNECTIONS_PER_IP_PER_S`; also the burst. */
    readonly newConnectionsPerIpPerS: number;
}

export type IpRefusal = 'global-limit' | 'ip-limit' | 'ip-rate';

export type IpAdmission =
    | { readonly kind: 'admitted'; /** Idempotent. */ release(): void }
    | { readonly kind: 'refused'; readonly reason: IpRefusal };

export interface IpLimiter {
    /** At TCP accept, before reading anything. IPv6 addresses count per /64. */
    admit(ip: string): IpAdmission;
    connections(): number;
    /** IPs (or /64s) the limiter remembers: open connections, or a rate bucket still refilling. */
    trackedIps(): number;
}

interface IpState {
    open: number;
    readonly bucket: TokenBucket;
}

/** Below this many tracked IPs the limiter never sweeps; above it, sweeps whenever the count doubles. */
const MIN_SWEEP_AT = 1024;

export function createIpLimiter(limits: IpLimits, clock: Clock): IpLimiter {
    const states = new Map<string, IpState>();
    let open = 0;
    let sweepAt = MIN_SWEEP_AT;

    // An IP without connections is kept only while its rate bucket refills, so it cannot reset its rate by
    // disconnecting; the sweep runs at doubling sizes, so it costs O(1) per admission.
    function sweep(): void {
        for (const [key, state] of states) if (state.open === 0 && state.bucket.isFull()) states.delete(key);
        sweepAt = Math.max(MIN_SWEEP_AT, states.size * 2);
    }

    return {
        admit(ip) {
            if (open >= limits.maxConnections) return { kind: 'refused', reason: 'global-limit' };
            if (states.size >= sweepAt) sweep();
            const key = ipLimitKey(ip);
            let state = states.get(key);
            if (state === undefined) {
                const rate = limits.newConnectionsPerIpPerS;
                state = { open: 0, bucket: createTokenBucket({ capacity: rate, refillPerSecond: rate, clock }) };
                states.set(key, state);
            }
            if (state.open >= limits.maxConnectionsPerIp) return { kind: 'refused', reason: 'ip-limit' };
            if (!state.bucket.tryTake(1)) return { kind: 'refused', reason: 'ip-rate' };
            const held = state;
            held.open++;
            open++;
            let released = false;
            return {
                kind: 'admitted',
                release() {
                    if (released) return;
                    released = true;
                    held.open--;
                    open--;
                },
            };
        },
        connections: () => open,
        trackedIps: () => states.size,
    };
}
