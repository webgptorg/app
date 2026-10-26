import type { Clock } from '../clock';
import { ipLimitKey } from '../ip-address';
import type { TokenBucket } from '../limits/token-bucket';
import { createTokenBucket } from '../limits/token-bucket';

export interface HandshakeLimits {
    /** `RELAY_MAX_PENDING_HANDSHAKES`: connections between TCP accept and `ready`, relay-wide. */
    readonly maxPending: number;
    /** `RELAY_MAX_PENDING_HANDSHAKES_PER_IP`, per IPv4 address and per IPv6 /64 like every per-IP limit. */
    readonly maxPendingPerIp: number;
    /**
     * `RELAY_TUNNEL_HANDSHAKES_PER_IP_PER_MIN`: handshakes started per IP (or /64) and minute, also the burst, so one
     * address cannot spend the relay-wide registry-miss budget or signature checks on attempts it repeats.
     */
    readonly handshakesPerIpPerMin: number;
}

export type AdmissionVerdict = 'admitted' | 'rate-limited';

export interface Admission {
    /** `rate-limited`: the connection may finish TLS and the upgrade only to receive `reject`. */
    readonly verdict: AdmissionVerdict;
    /** Frees the slot; idempotent. */
    release(): void;
}

export interface HandshakeLimiter {
    /** `null`: drop the socket without TLS, because even the connections waiting for their `reject` are at the limit. */
    admit(ip: string): Admission | null;
    /** Addresses whose handshake rate is remembered: a bucket still refilling. */
    trackedIps(): number;
}

interface Pool {
    total: number;
    readonly perIp: Map<string, number>;
}

/** Below this many remembered addresses the rate map is never swept; above it, whenever its size doubles. */
const MIN_SWEEP_AT = 1024;

/**
 * Pending handshakes are counted from TCP accept, so a slow TLS client holds its slot too. A connection over the limit
 * (pending, or the address's handshake rate) is told `rate-limited` (so the engine backs off rather than retrying
 * blindly), and those connections have a pool of the same size; past that the socket is dropped, so refusals cannot
 * cost more than the handshakes they refuse.
 */
export function createHandshakeLimiter(limits: HandshakeLimits, clock: Clock): HandshakeLimiter {
    const admitted: Pool = { total: 0, perIp: new Map() };
    const refused: Pool = { total: 0, perIp: new Map() };
    const rates = new Map<string, TokenBucket>();
    let sweepAt = MIN_SWEEP_AT;

    function hasRoom(pool: Pool, ip: string): boolean {
        return pool.total < limits.maxPending && (pool.perIp.get(ip) ?? 0) < limits.maxPendingPerIp;
    }

    // An address is forgotten once its bucket is full again, so memory follows the addresses still trying.
    function rateOf(ip: string): TokenBucket {
        if (rates.size >= sweepAt) {
            for (const [key, bucket] of rates) if (bucket.isFull()) rates.delete(key);
            sweepAt = Math.max(MIN_SWEEP_AT, rates.size * 2);
        }
        let bucket = rates.get(ip);
        if (bucket === undefined) {
            const perMin = limits.handshakesPerIpPerMin;
            bucket = createTokenBucket({ capacity: perMin, refillPerSecond: perMin / 60, clock });
            rates.set(ip, bucket);
        }
        return bucket;
    }

    function take(pool: Pool, ip: string, verdict: AdmissionVerdict): Admission {
        pool.total++;
        pool.perIp.set(ip, (pool.perIp.get(ip) ?? 0) + 1);
        let released = false;
        return {
            verdict,
            release() {
                if (released) return;
                released = true;
                pool.total--;
                const count = (pool.perIp.get(ip) as number) - 1;
                if (count === 0) pool.perIp.delete(ip);
                else pool.perIp.set(ip, count);
            },
        };
    }

    return {
        admit(ip) {
            const key = ipLimitKey(ip);
            if (hasRoom(admitted, key) && rateOf(key).tryTake(1)) return take(admitted, key, 'admitted');
            if (hasRoom(refused, key)) return take(refused, key, 'rate-limited');
            return null;
        },
        trackedIps: () => rates.size,
    };
}
