import type { ClientHelloParse, Hostname, RelayId } from '@ptbk/protocol';
import { Hostname as HostnameSchema, engineIdFromDefaultHostname } from '@ptbk/protocol';

import type { SessionTable, TableSession } from '../tunnel/session-table';

/** A ClientHello the buffer has judged: routing never sees `need-more`. */
export type ClientHelloVerdict = Exclude<ClientHelloParse, { readonly kind: 'need-more' }>;

export type RouteRejectReason = 'no-sni' | 'malformed' | 'too-large' | 'unknown-host' | 'engine-offline';

export type RouteDecision<S> =
    | { readonly kind: 'own' }
    | { readonly kind: 'engine'; readonly session: S; readonly hostname: Hostname }
    | { readonly kind: 'reject'; readonly reason: RouteRejectReason };

export interface RouteContext<S extends TableSession> {
    /** The only name the relay terminates TLS for. */
    readonly relayHostname: RelayId;
    /** Tells `engine-offline` (an engine's default hostname) from `unknown-host`. */
    readonly engineDomain: Hostname;
    /** The routable hostnames of connected engines; nothing here resolves DNS or reads claims. */
    readonly sessions: Pick<SessionTable<S>, 'byHostname'>;
}

/**
 * Decides from the SNI alone. ALPN is never consulted, so an ACME `acme-tls/1` validation reaches the engine like any
 * browser. A hostname two connected engines claim is absent from `byHostname` and therefore `unknown-host`; such a
 * conflict can only involve custom hostnames, which lie outside the engine domain (C-03), so it is never
 * `engine-offline`.
 */
export function routeConnection<S extends TableSession>(
    parse: ClientHelloVerdict,
    ctx: RouteContext<S>,
): RouteDecision<S> {
    switch (parse.kind) {
        case 'no-sni':
        case 'malformed':
        case 'too-large':
            return { kind: 'reject', reason: parse.kind };
        case 'sni': {
            const branded = HostnameSchema.safeParse(parse.hostname);
            if (!branded.success) return { kind: 'reject', reason: 'malformed' };
            const hostname = branded.data;
            if (hostname === (ctx.relayHostname as string)) return { kind: 'own' };
            const session = ctx.sessions.byHostname(hostname);
            if (session !== undefined) return { kind: 'engine', session, hostname };
            const isEngineHostname = engineIdFromDefaultHostname(hostname, ctx.engineDomain).kind === 'default';
            return { kind: 'reject', reason: isEngineHostname ? 'engine-offline' : 'unknown-host' };
        }
    }
}
