import type { Bytes, Hostname, RelayId, TunnelAuth, TunnelChallenge } from '@ptbk/protocol';
import { AUTH_TIMEOUT_MS, PING_INTERVAL_MS, TUNNEL_CLOSE_CODE } from '@ptbk/protocol';

import { EventQueue, TIMED_OUT } from '../fake-relay/event-queue';
import type { FakeRelay, RelayConnection } from '../fake-relay/fake-relay';
import { RelayTunnel } from '../fake-relay/relay-tunnel';
import { acceptConnection, honestReady } from './handshake';

/**
 * The engine under test, as the tunnel suite sees it. The platform harness (C-08) provides it for a spawned engine;
 * tests provide one for in-process fakes.
 */
export interface TunnelEngine {
    readonly engineDomain: Hostname;
    /** Raw 32-byte Ed25519 key; null skips the checks that verify signatures. */
    readonly enginePublicKey: Bytes | null;
    /**
     * Starts the engine again with fresh in-memory state (backoff counters, a relay link stopped by `REPLACED`), with
     * `envPatch` merged over its environment (`null` removes a variable). Absent: checks that need it skip.
     */
    restart?(envPatch?: Readonly<Record<string, string | null>>): Promise<void>;
    /** False once the engine process exited; absent when the harness cannot tell. */
    running?(): boolean;
    /** What the engine logged so far, when the harness captures it; checked for leaked proxy credentials. */
    logs?(): string;
    /** The engine's own TLS trust anchor (PEM), when it serves certificates from a CA the suite can know. */
    readonly certificateAuthorityPem?: string | null;
}

/**
 * How long the suite waits for things. The defaults are the contract (C-02) plus tolerance; tests of the suite itself
 * shorten them for in-process engines, never to make a real engine pass.
 */
export interface TunnelTiming {
    /** The engine must answer a challenge within this (the relay's `AUTH_TIMEOUT_MS`). */
    readonly authMs: number;
    /** A tunnel that went away must be ready again within this: backoff cap plus jitter plus a margin. */
    readonly reconnectMs: number;
    /** After a relay restart the tunnel should be back within 10 s (spike criterion), plus a margin. */
    readonly relayRestartMs: number;
    /** After `SHUTTING_DOWN` the engine should be back soon, "with a short jitter". */
    readonly shuttingDownMs: number;
    /** The engine must close the tunnel this soon after a protocol error from the relay. */
    readonly closeMs: number;
    /** How long the suite watches for something that must not happen (an auth, an upgrade, a frame). */
    readonly observeMs: number;
    /** After `REPLACED`, how long the suite watches for reconnects. */
    readonly replacedObserveMs: number;
    /** No frame for this long means the engine stopped sending. */
    readonly quietMs: number;
    /** A ping must arrive this soon after `ready`. */
    readonly pingMs: number;
    /** Five consecutive failed attempts must spread over at least this much time (no tight reconnect loop). */
    readonly minBackoffSpreadMs: number;
    /** For one request through a stream: TLS handshake and HTTP answer. */
    readonly requestMs: number;
    /** How many failed or broken tunnels the suite causes before it asks for a fresh engine (when it can). */
    readonly disruptionBudget: number;
}

export const CONTRACT_TIMING: TunnelTiming = Object.freeze({
    authMs: AUTH_TIMEOUT_MS,
    reconnectMs: 30_000,
    relayRestartMs: 15_000,
    shuttingDownMs: 5_000,
    closeMs: 5_000,
    observeMs: 3_000,
    replacedObserveMs: 10_000,
    quietMs: 1_000,
    pingMs: PING_INTERVAL_MS + 10_000,
    minBackoffSpreadMs: 1_000,
    requestMs: 15_000,
    disruptionBudget: 3,
});

type RelayMode = { readonly kind: 'auto' } | { readonly kind: 'manual'; readonly queue: EventQueue<RelayConnection> };

/**
 * The relay side of a run: by default every relay accepts the engine as an honest relay would and keeps its tunnel
 * ready; a check takes one relay into manual mode to script the next connections itself.
 */
export class TunnelRuntime {
    readonly relay: FakeRelay;
    readonly engine: TunnelEngine;
    readonly timing: TunnelTiming;
    /** Every connection the engine opened, per relay, in order: when it came and how it ended. */
    readonly attempts = new Map<RelayId, number[]>();
    readonly allTunnels: RelayTunnel[] = [];
    readonly #modes = new Map<RelayId, RelayMode>();
    readonly #tunnels = new Map<RelayId, RelayTunnel[]>();
    readonly #readyWaiters = new Set<{ relayId: RelayId; after: number; resolve: (tunnel: RelayTunnel) => void }>();
    readonly #adopted = new Set<RelayConnection>();
    #disruptions = 0;

    constructor(relay: FakeRelay, engine: TunnelEngine, timing: TunnelTiming) {
        this.relay = relay;
        this.engine = engine;
        this.timing = timing;
        for (const relayId of relay.relayIds) {
            this.#modes.set(relayId, { kind: 'auto' });
            this.#tunnels.set(relayId, []);
            this.attempts.set(relayId, []);
        }
        relay.onConnection((connection) => {
            this.#onConnection(connection);
        });
    }

    get relayIds(): readonly RelayId[] {
        return this.relay.relayIds;
    }

    /** The relay most checks script; the others keep honest tunnels meanwhile. */
    get primary(): RelayId {
        const [first] = this.relay.relayIds;
        if (first === undefined) throw new RangeError('no relay');
        return first;
    }

    /** Counts a tunnel the suite made fail, so a later check can ask for a fresh engine before relying on timing. */
    disrupted(count = 1): void {
        this.#disruptions += count;
    }

    /** Restarts the engine when the suite made it back off too often, so timing-sensitive checks start from zero. */
    async calm(signal: AbortSignal): Promise<void> {
        if (this.#disruptions < this.timing.disruptionBudget || this.engine.restart === undefined) return;
        await this.restartEngine(undefined, signal);
    }

    async restartEngine(
        envPatch: Readonly<Record<string, string | null>> | undefined,
        signal: AbortSignal,
    ): Promise<void> {
        if (this.engine.restart === undefined) throw new Error('the engine cannot be restarted');
        for (const relayId of this.relayIds) this.#modes.set(relayId, { kind: 'auto' });
        await this.engine.restart(envPatch);
        this.#disruptions = 0;
        signal.throwIfAborted();
    }

    /** Open, ready tunnels to `relayId`, oldest first. */
    openTunnels(relayId: RelayId): RelayTunnel[] {
        return (this.#tunnels.get(relayId) ?? []).filter((tunnel) => tunnel.isOpen());
    }

    /** A ready tunnel to `relayId` that became ready after `after` (default: any open one). */
    async waitReady(relayId: RelayId, timeoutMs: number, signal: AbortSignal, after = -1): Promise<RelayTunnel | null> {
        const existing = this.openTunnels(relayId).find((tunnel) => tunnel.readyAt > after);
        if (existing !== undefined) return existing;
        return new Promise((resolve, reject) => {
            const waiter = {
                relayId,
                after,
                resolve: (tunnel: RelayTunnel) => {
                    finish();
                    resolve(tunnel);
                },
            };
            const finish = (): void => {
                clearTimeout(timer);
                this.#readyWaiters.delete(waiter);
                signal.removeEventListener('abort', onAbort);
            };
            const onAbort = (): void => {
                finish();
                reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
            };
            const timer = setTimeout(() => {
                finish();
                resolve(null);
            }, timeoutMs);
            signal.addEventListener('abort', onAbort, { once: true });
            this.#readyWaiters.add(waiter);
        });
    }

    /** Waits for every relay to have a ready tunnel; returns the relays that did not get one in time. */
    async waitAllReady(timeoutMs: number, signal: AbortSignal): Promise<RelayId[]> {
        const results = await Promise.all(
            this.relayIds.map(async (relayId) =>
                (await this.waitReady(relayId, timeoutMs, signal)) === null ? relayId : null,
            ),
        );
        return results.filter((relayId): relayId is RelayId => relayId !== null);
    }

    /**
     * Takes `relayId` into manual mode: its open tunnels close with `SHUTTING_DOWN` (the engine comes back soon) and
     * every new connection goes to `script` instead of the honest handshake. Back in auto mode afterwards, the suite
     * waits for the engine to reconnect so the next check starts with a ready tunnel.
     */
    async manual<T>(
        relayId: RelayId,
        signal: AbortSignal,
        script: (next: (timeoutMs: number) => Promise<RelayConnection | null>) => Promise<T>,
        options: { readonly keepTunnels?: boolean; readonly awaitReady?: boolean } = {},
    ): Promise<T> {
        const queue = new EventQueue<RelayConnection>();
        const opened: RelayConnection[] = [];
        this.#adopted.clear();
        this.#modes.set(relayId, { kind: 'manual', queue });
        if (options.keepTunnels !== true) {
            for (const tunnel of this.openTunnels(relayId)) tunnel.close(TUNNEL_CLOSE_CODE.SHUTTING_DOWN);
        }
        try {
            return await script(async (timeoutMs) => {
                const connection = await queue.next(timeoutMs, signal);
                if (connection === TIMED_OUT) return null;
                opened.push(connection);
                return connection;
            });
        } finally {
            this.#modes.set(relayId, { kind: 'auto' });
            for (const connection of [...queue.drain(), ...opened]) {
                if (!this.#adopted.has(connection)) connection.close(TUNNEL_CLOSE_CODE.SHUTTING_DOWN);
            }
            if (!signal.aborted && options.awaitReady !== false) {
                await this.waitReady(relayId, this.timing.reconnectMs, signal);
            }
        }
    }

    /**
     * Finishes a manual connection's handshake as an honest relay and keeps the tunnel like an automatic one, so the
     * engine is ready again without a close (closing during the handshake makes an engine back off).
     */
    async adopt(connection: RelayConnection, signal: AbortSignal): Promise<RelayTunnel | null> {
        this.#adopted.add(connection);
        const accepted = await acceptConnection(connection, {
            engineKey: this.engine.enginePublicKey,
            engineDomain: this.engine.engineDomain,
            authTimeoutMs: this.timing.authMs,
            signal,
        });
        if (accepted.kind === 'failed') {
            this.disrupted();
            return null;
        }
        this.#keep(accepted.tunnel);
        return accepted.tunnel;
    }

    /** Answers an `auth` a check already received with an honest `ready`, and keeps the tunnel. */
    complete(connection: RelayConnection, challenge: TunnelChallenge, auth: TunnelAuth): RelayTunnel | null {
        this.#adopted.add(connection);
        const ready = honestReady(challenge, auth, this.engine.engineDomain);
        if (ready === null) {
            connection.sendJson({ v: 1, type: 'reject', reason: 'unsupported-version' });
            connection.close(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
            this.disrupted();
            return null;
        }
        const tunnel = new RelayTunnel(connection, { challenge, auth, ready });
        connection.sendJson(ready);
        this.#keep(tunnel);
        return tunnel;
    }

    #keep(tunnel: RelayTunnel): void {
        const relayId = tunnel.connection.relayId;
        const kept = (this.#tunnels.get(relayId) ?? []).filter((candidate) => candidate.isOpen());
        kept.push(tunnel);
        this.#tunnels.set(relayId, kept);
        // Every tunnel of the run stays reachable for checks that judge the engine's framing across the run.
        this.allTunnels.push(tunnel);
        for (const waiter of [...this.#readyWaiters]) {
            if (waiter.relayId === relayId && tunnel.readyAt > waiter.after) waiter.resolve(tunnel);
        }
    }

    #onConnection(connection: RelayConnection): void {
        this.attempts.get(connection.relayId)?.push(connection.openedAt);
        const mode = this.#modes.get(connection.relayId) ?? { kind: 'auto' };
        if (mode.kind === 'manual') {
            mode.queue.push(connection);
            return;
        }
        void this.#accept(connection);
    }

    async #accept(connection: RelayConnection): Promise<void> {
        const accepted = await acceptConnection(connection, {
            engineKey: this.engine.enginePublicKey,
            engineDomain: this.engine.engineDomain,
            authTimeoutMs: this.timing.authMs,
            signal: AbortSignal.timeout(this.timing.authMs + 1_000),
        }).catch(() => ({ kind: 'failed' as const, reason: 'aborted' }));
        if (accepted.kind === 'failed') {
            this.disrupted();
            return;
        }
        this.#keep(accepted.tunnel);
    }
}
