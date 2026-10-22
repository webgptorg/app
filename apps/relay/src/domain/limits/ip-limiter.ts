import type { Clock } from '../clock';
import { ipLimitKey, ipv6WiderPrefixes } from '../ip-address';
import type { TokenBucket } from './token-bucket';
import { createTokenBucket } from './token-bucket';

export interface IpLimits {
    /** `RELAY_MAX_CONNECTIONS_PER_IP`: open connections per IPv4 address and per IPv6 /64. */
    readonly maxConnectionsPerIp: number;
    /** `RELAY_MAX_CONNECTIONS_PER_IPV6_56`: the usual subscriber delegation. */
    readonly maxConnectionsPerIpv6Slash56: number;
    /** `RELAY_MAX_CONNECTIONS_PER_IPV6_48`: the usual site delegation. */
    readonly maxConnectionsPerIpv6Slash48: number;
    /** `RELAY_NEW_CONNECTIONS_PER_IP_PER_S`, per IPv4 address and per IPv6 /64; also the burst. */
    readonly newConnectionsPerIpPerS: number;
}

export type IpRefusal = 'ip-limit' | 'ipv6-56-limit' | 'ipv6-48-limit' | 'ip-rate';

export type IpAdmission =
    | { readonly kind: 'admitted'; /** Idempotent. */ release(): void }
    | { readonly kind: 'refused'; readonly reason: IpRefusal };

export interface IpLimiter {
    /** At TCP accept, before reading anything. */
    admit(ip: string): IpAdmission;
    /** Addresses and prefixes the limiter remembers: open connections, or a rate bucket still refilling. */
    trackedIps(): number;
}

interface Counted {
    open: number;
}

interface AddressState extends Counted {
    readonly bucket: TokenBucket;
}

/** Below this many tracked keys the limiter never sweeps; above it, sweeps whenever the count doubles. */
const MIN_SWEEP_AT = 1024;

/**
 * Per-source limits before a connection's first byte. IPv6 counts at /64, /56 and /48 at once, so rotating through
 * the /64s of one delegation does not multiply the cap. Only the address (or /64) has a rate.
 */
export function createIpLimiter(limits: IpLimits, clock: Clock): IpLimiter {
    const addresses = new Map<string, AddressState>();
    const prefixes = new Map<string, Counted>();
    let sweepAt = MIN_SWEEP_AT;

    // An address without connections is kept only while its rate bucket refills, so it cannot reset its rate by
    // disconnecting; the sweep runs at doubling sizes, so it costs O(1) per admission.
    function sweep(): void {
        for (const [key, state] of addresses) if (state.open === 0 && state.bucket.isFull()) addresses.delete(key);
        for (const [key, state] of prefixes) if (state.open === 0) prefixes.delete(key);
        sweepAt = Math.max(MIN_SWEEP_AT, (addresses.size + prefixes.size) * 2);
    }

    function addressOf(key: string): AddressState {
        let state = addresses.get(key);
        if (state === undefined) {
            const rate = limits.newConnectionsPerIpPerS;
            state = { open: 0, bucket: createTokenBucket({ capacity: rate, refillPerSecond: rate, clock }) };
            addresses.set(key, state);
        }
        return state;
    }

    function prefixOf(key: string): Counted {
        let state = prefixes.get(key);
        if (state === undefined) {
            state = { open: 0 };
            prefixes.set(key, state);
        }
        return state;
    }

    return {
        admit(ip) {
            if (addresses.size + prefixes.size >= sweepAt) sweep();
            const address = addressOf(ipLimitKey(ip));
            if (address.open >= limits.maxConnectionsPerIp) return { kind: 'refused', reason: 'ip-limit' };
            const held: Counted[] = [address];
            const wider = ipv6WiderPrefixes(ip);
            if (wider !== null) {
                const slash56 = prefixOf(wider.slash56);
                const slash48 = prefixOf(wider.slash48);
                if (slash56.open >= limits.maxConnectionsPerIpv6Slash56) {
                    return { kind: 'refused', reason: 'ipv6-56-limit' };
                }
                if (slash48.open >= limits.maxConnectionsPerIpv6Slash48) {
                    return { kind: 'refused', reason: 'ipv6-48-limit' };
                }
                held.push(slash56, slash48);
            }
            if (!address.bucket.tryTake(1)) return { kind: 'refused', reason: 'ip-rate' };
            for (const state of held) state.open++;
            let released = false;
            return {
                kind: 'admitted',
                release() {
                    if (released) return;
                    released = true;
                    for (const state of held) state.open--;
                },
            };
        },
        trackedIps: () => addresses.size + prefixes.size,
    };
}
