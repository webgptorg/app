import type { EngineId, Hostname, TunnelCloseCode } from '@ptbk/protocol';
import { TUNNEL_CLOSE_CODE } from '@ptbk/protocol';

import type { Logger } from '../logger';

export interface TableSession {
    readonly engineId: EngineId;
    readonly remoteIp: string;
    close(code: TunnelCloseCode): void;
}

/** The authenticated tunnels on this relay, by engine and by routable hostname. */
export interface SessionTable<S extends TableSession> {
    /** A newer tunnel for the same engine replaces the old one, which is closed with `REPLACED`. */
    register(session: S, hostnames: readonly Hostname[]): void;
    /** After revalidation; ignored for a session that is no longer registered. */
    updateHostnames(session: S, hostnames: readonly Hostname[]): void;
    byEngine(engineId: EngineId): S | undefined;
    /** `undefined` also when two connected engines both have `hostname` in their routable set. */
    byHostname(hostname: Hostname): S | undefined;
    hostnamesOf(session: S): readonly Hostname[];
    /** Ignored unless `session` is the one registered for its engine, so a replaced session cannot evict its successor. */
    remove(session: S): void;
    sessions(): readonly S[];
    countByIp(ip: string): number;
}

export function createSessionTable<S extends TableSession>(deps: { readonly logger: Logger }): SessionTable<S> {
    const { logger } = deps;
    const byEngine = new Map<EngineId, S>();
    const hostnamesBySession = new Map<S, readonly Hostname[]>();
    const claimants = new Map<Hostname, Set<S>>();
    const perIp = new Map<string, number>();

    function index(session: S, hostnames: readonly Hostname[]): void {
        hostnamesBySession.set(session, hostnames);
        for (const hostname of hostnames) {
            const holders = claimants.get(hostname) ?? new Set<S>();
            const [other] = holders;
            // Logged once, when a hostname gains its second claimant; never the hostname itself.
            if (other !== undefined && other !== session && holders.size === 1) {
                logger.warn('hostname.conflict', { engineId: session.engineId, otherEngineId: other.engineId });
            }
            holders.add(session);
            claimants.set(hostname, holders);
        }
    }

    function unindex(session: S, keep: ReadonlySet<Hostname> = new Set()): void {
        for (const hostname of hostnamesBySession.get(session) ?? []) {
            if (keep.has(hostname)) continue;
            const holders = claimants.get(hostname);
            holders?.delete(session);
            if (holders?.size === 0) claimants.delete(hostname);
        }
        hostnamesBySession.delete(session);
    }

    function countIp(ip: string, delta: number): void {
        const count = (perIp.get(ip) ?? 0) + delta;
        if (count === 0) perIp.delete(ip);
        else perIp.set(ip, count);
    }

    function drop(session: S): void {
        unindex(session);
        byEngine.delete(session.engineId);
        countIp(session.remoteIp, -1);
    }

    return {
        register(session, hostnames) {
            const previous = byEngine.get(session.engineId);
            if (previous === session) return;
            if (previous !== undefined) {
                drop(previous);
                previous.close(TUNNEL_CLOSE_CODE.REPLACED);
            }
            byEngine.set(session.engineId, session);
            countIp(session.remoteIp, 1);
            index(session, [...new Set(hostnames)]);
        },
        updateHostnames(session, hostnames) {
            if (byEngine.get(session.engineId) !== session) return;
            const next = new Set(hostnames);
            unindex(session, next);
            index(session, [...next]);
        },
        byEngine: (engineId) => byEngine.get(engineId),
        byHostname(hostname) {
            const holders = claimants.get(hostname);
            if (holders?.size !== 1) return undefined;
            const [session] = holders;
            return session;
        },
        hostnamesOf: (session) => hostnamesBySession.get(session) ?? [],
        remove(session) {
            if (byEngine.get(session.engineId) === session) drop(session);
        },
        sessions: () => [...byEngine.values()],
        countByIp: (ip) => perIp.get(ip) ?? 0,
    };
}
