import type { Hostname } from '@ptbk/protocol';
import { MAX_REGISTRY_HOSTNAMES, TUNNEL_CLOSE_CODE, deriveEngineId, ed25519PublicKeyToBytes } from '@ptbk/protocol';

import type { Clock } from '../clock';
import type { DnsResolver } from '../dns-resolver';
import type { EngineRegistry } from '../engine-registry';
import { routableHostnames } from '../hostname-policy';
import type { Logger } from '../logger';
import type { SessionTable, TableSession } from './session-table';

export interface RevalidatorOptions<S extends TableSession> {
    readonly clock: Clock;
    /** `RELAY_REGISTRY_TTL_S`, so every round asks the registry's source rather than the cache. */
    readonly intervalMs: number;
    readonly table: SessionTable<S>;
    /** The cached registry: during an outage it answers from stale entries up to `RELAY_REGISTRY_MAX_STALE_S`. */
    readonly registry: EngineRegistry;
    readonly dns: DnsResolver;
    readonly engineDomain: Hostname;
    readonly logger: Logger;
}

export interface Revalidator {
    start(): void;
    /** Cancels the next round and aborts the running one. */
    stop(): void;
    /** One round over every connected engine; never rejects. */
    runOnce(): Promise<void>;
}

/**
 * Re-checks every connected engine against the registry: a suspended engine is cut with `SUSPENDED`, one that is gone,
 * unavailable past the stale window or no longer matches its key with `AUTH_FAILED`, and everyone else's routable
 * hostnames (claims and CNAMEs) are recomputed.
 */
export function createRevalidator<S extends TableSession>(options: RevalidatorOptions<S>): Revalidator {
    const { clock, intervalMs, table, registry, dns, engineDomain, logger } = options;
    let controller = new AbortController();
    let cancelNext: (() => void) | null = null;
    // Bumped by stop, so a round still running from before cannot schedule a second chain after a restart.
    let generation = 0;

    async function revalidate(session: S, signal: AbortSignal): Promise<void> {
        const { engineId } = session;
        const lookup = await registry.lookup(engineId, signal);
        const current = (): boolean => table.byEngine(engineId) === session;
        if (!current()) return;
        if (lookup.kind !== 'found') {
            logger.warn('tunnel.revoked', { engineId, reason: lookup.kind });
            session.close(TUNNEL_CLOSE_CODE.AUTH_FAILED);
            return;
        }
        const { entry } = lookup;
        if ((await deriveEngineId(ed25519PublicKeyToBytes(entry.enginePublicKey))) !== engineId) {
            logger.warn('tunnel.revoked', { engineId, reason: 'id-key-mismatch' });
            session.close(TUNNEL_CLOSE_CODE.AUTH_FAILED);
            return;
        }
        if (entry.status === 'suspended') {
            logger.warn('tunnel.revoked', { engineId, reason: 'suspended' });
            session.close(TUNNEL_CLOSE_CODE.SUSPENDED);
            return;
        }
        const hostnames = await routableHostnames({ engineId, entry, engineDomain, dns, logger, signal });
        if (current()) table.updateHostnames(session, hostnames.slice(0, MAX_REGISTRY_HOSTNAMES));
    }

    async function runOnce(): Promise<void> {
        const { signal } = controller;
        // Only an abort (stop) rejects here; the cached registry and resolver answer every failure as a value.
        await Promise.allSettled(table.sessions().map((session) => revalidate(session, signal)));
    }

    function schedule(round: number): void {
        cancelNext = clock.setTimeout(() => {
            void runOnce().then(() => {
                if (round === generation) schedule(round);
            });
        }, intervalMs);
    }

    return {
        start() {
            if (cancelNext !== null) return;
            controller = new AbortController();
            schedule(generation);
        },
        stop() {
            cancelNext?.();
            cancelNext = null;
            generation++;
            controller.abort(new DOMException('relay stopping', 'AbortError'));
        },
        runOnce,
    };
}
