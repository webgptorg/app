import type { Hostname } from '@ptbk/protocol';

export type RelayProbe =
    /** `/healthz` answered `ok` over a verified TLS connection, and `/metrics` answered the token. */
    | { readonly kind: 'up'; readonly metrics: string }
    | { readonly kind: 'down'; readonly reason: 'tls' | 'healthz' | 'metrics' | 'timeout' };

/** Reaches a relay on its own hostname, as a browser or an engine would. */
export interface RelayProber {
    probe(relayId: Hostname, signal: AbortSignal): Promise<RelayProbe>;
}
