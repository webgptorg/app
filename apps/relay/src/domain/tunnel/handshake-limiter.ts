import { ipLimitKey } from '../ip-address';

export interface HandshakeLimits {
    /** `RELAY_MAX_PENDING_HANDSHAKES`: connections between TCP accept and `ready`, relay-wide. */
    readonly maxPending: number;
    /** `RELAY_MAX_PENDING_HANDSHAKES_PER_IP`, per IPv4 address and per IPv6 /64 like every per-IP limit. */
    readonly maxPendingPerIp: number;
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
}

interface Pool {
    total: number;
    readonly perIp: Map<string, number>;
}

/**
 * Pending handshakes are counted from TCP accept, so a slow TLS client holds its slot too. A connection over the limit
 * is told `rate-limited` (so the engine backs off rather than retrying blindly), and those connections have a pool of
 * the same size; past that the socket is dropped, so refusals cannot cost more than the handshakes they refuse.
 */
export function createHandshakeLimiter(limits: HandshakeLimits): HandshakeLimiter {
    const admitted: Pool = { total: 0, perIp: new Map() };
    const refused: Pool = { total: 0, perIp: new Map() };

    function hasRoom(pool: Pool, ip: string): boolean {
        return pool.total < limits.maxPending && (pool.perIp.get(ip) ?? 0) < limits.maxPendingPerIp;
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
            if (hasRoom(admitted, key)) return take(admitted, key, 'admitted');
            if (hasRoom(refused, key)) return take(refused, key, 'rate-limited');
            return null;
        },
    };
}
