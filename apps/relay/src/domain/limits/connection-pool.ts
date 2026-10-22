import type { Clock } from '../clock';

/** Above this share of the pending budget, the ClientHello timeout drops to the pressure timeout. */
export const PENDING_PRESSURE_SHARE = 0.8;

export interface ConnectionPoolLimits {
    /** `RELAY_MAX_CONNECTIONS`: every open connection on the listener, the relay's own included. */
    readonly maxConnections: number;
    /** Connections whose ClientHello has not been judged yet (`RELAY_PENDING_CONNECTIONS_PERCENT` of the cap). */
    readonly maxPending: number;
    /** Kept for the relay's own hostname (`RELAY_RESERVED_CONNECTIONS_PERCENT`): engine-bound connections never use it. */
    readonly reserved: number;
    /** `RELAY_CLIENT_HELLO_TIMEOUT_MS`, from TCP accept. */
    readonly clientHelloTimeoutMs: number;
    /** `RELAY_CLIENT_HELLO_PRESSURE_TIMEOUT_MS`: the timeout while the pending budget is above its pressure share. */
    readonly pressureClientHelloTimeoutMs: number;
}

/** Why the pool ended a connection before its ClientHello was judged. */
export type PendingEnd = 'timeout' | 'evicted';

export type Destination = 'own' | 'engine';

export interface PooledConnection {
    /**
     * The ClientHello was judged; stops its deadline. `false`: an engine-bound connection that would eat into the
     * reserve (`global-limit`). Only the first call counts.
     */
    route(destination: Destination): boolean;
    /** The connection closed. Idempotent, and a no-op once the pool ended it. */
    release(): void;
}

export type PoolAdmission =
    | { readonly kind: 'admitted'; readonly connection: PooledConnection }
    | { readonly kind: 'refused'; readonly reason: 'global-limit' };

export interface ConnectionPool {
    /**
     * At TCP accept. `end` runs at most once, if the pool ends the connection before its ClientHello was judged; the
     * caller then closes it. The pool stops counting it at that moment, so its slot is free at once.
     */
    admit(end: (reason: PendingEnd) => void): PoolAdmission;
    /** Open connections the pool counts. */
    connections(): number;
    /** Of those, connections whose ClientHello is not judged yet. */
    pending(): number;
}

interface Entry {
    state: 'pending' | 'engine' | 'other' | 'ended';
    readonly acceptedAtMs: number;
    readonly end: (reason: PendingEnd) => void;
    readonly cancelDeadline: () => void;
}

/**
 * Admission before the ClientHello. A flood of connections that never send one can take only the pending budget, and
 * once that is full each new connection evicts the oldest pending one instead of being refused, so a browser that
 * sends its ClientHello promptly always gets through. Engine-bound connections never use the reserve, so engines can
 * always reach the relay's own hostname to reconnect.
 */
export function createConnectionPool(limits: ConnectionPoolLimits, clock: Clock): ConnectionPool {
    const { maxConnections, maxPending, reserved, clientHelloTimeoutMs, pressureClientHelloTimeoutMs } = limits;
    const pressureAbove = Math.floor(maxPending * PENDING_PRESSURE_SHARE);
    // Insertion order is accept order, so the first entry is always the oldest.
    const pending = new Set<Entry>();
    let total = 0;
    let engineBound = 0;
    let cancelPressure: (() => void) | null = null;

    const oldest = (): Entry | undefined => pending.values().next().value;

    function end(entry: Entry, reason: PendingEnd): void {
        pending.delete(entry);
        entry.cancelDeadline();
        entry.state = 'ended';
        total--;
        entry.end(reason);
    }

    // One timer for the oldest pending connection: under pressure, deadlines expire in accept order.
    function armPressure(): void {
        if (cancelPressure !== null || pending.size <= pressureAbove) return;
        const first = oldest() as Entry;
        cancelPressure = clock.setTimeout(
            onPressure,
            first.acceptedAtMs + pressureClientHelloTimeoutMs - clock.nowMs(),
        );
    }

    function onPressure(): void {
        cancelPressure = null;
        const nowMs = clock.nowMs();
        while (pending.size > pressureAbove) {
            const first = oldest() as Entry;
            if (first.acceptedAtMs + pressureClientHelloTimeoutMs > nowMs) break;
            end(first, 'timeout');
        }
        armPressure();
    }

    return {
        admit(onEnd) {
            if (total >= maxConnections || pending.size >= maxPending) {
                const victim = oldest();
                if (victim === undefined) return { kind: 'refused', reason: 'global-limit' };
                end(victim, 'evicted');
            }
            total++;
            const entry: Entry = {
                state: 'pending',
                acceptedAtMs: clock.nowMs(),
                end: onEnd,
                cancelDeadline: clock.setTimeout(() => {
                    end(entry, 'timeout');
                }, clientHelloTimeoutMs),
            };
            pending.add(entry);
            armPressure();
            return {
                kind: 'admitted',
                connection: {
                    route(destination) {
                        if (entry.state !== 'pending') return false;
                        pending.delete(entry);
                        entry.cancelDeadline();
                        if (destination === 'own' || engineBound >= maxConnections - reserved) {
                            entry.state = 'other';
                            return destination === 'own';
                        }
                        entry.state = 'engine';
                        engineBound++;
                        return true;
                    },
                    release() {
                        switch (entry.state) {
                            case 'ended':
                                return;
                            case 'pending':
                                pending.delete(entry);
                                entry.cancelDeadline();
                                break;
                            case 'engine':
                                engineBound--;
                                break;
                            case 'other':
                                break;
                        }
                        entry.state = 'ended';
                        total--;
                    },
                },
            };
        },
        connections: () => total,
        pending: () => pending.size,
    };
}
