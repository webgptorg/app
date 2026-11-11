import type { EngineId } from '@ptbk/engine-api';

/** Stable IDs, in the order the check runs and reports them. */
export const STAGING_CHECK_IDS = [
    'staging.dns.via-relay',
    'staging.tls.public-certificate',
    'staging.gateway.sign-in',
    'staging.gateway.setup',
    'staging.gateway.anonymous',
    'staging.headers.csp',
    'staging.engine.info',
    'staging.ui.release',
    'staging.ui.served',
] as const;
export type StagingCheckId = (typeof STAGING_CHECK_IDS)[number];

export type StagingStatus = 'pass' | 'fail' | 'skip';

export interface StagingResult {
    readonly id: StagingCheckId;
    readonly status: StagingStatus;
    readonly detail: string;
    /** What to change; set for every fail and skip. */
    readonly fix?: string;
}

export interface StagingReport {
    readonly engine: string;
    /** No check failed; skips do not count against it. */
    readonly ok: boolean;
    readonly checks: readonly StagingResult[];
}

export type DnsAnswer =
    | { readonly kind: 'resolved'; readonly addresses: readonly string[] }
    | { readonly kind: 'failed'; readonly code: string };

export interface CertificateName {
    readonly organization: string | null;
    readonly commonName: string | null;
}

export type TlsProbe =
    | {
          readonly kind: 'handshake';
          /** Whether the chain verifies against the roots the probe was given (Node's bundled public roots). */
          readonly authorized: boolean;
          readonly authorizationError: string | null;
          readonly hostnameMatches: boolean;
          readonly issuer: CertificateName;
          readonly validToMs: number;
      }
    | { readonly kind: 'failed'; readonly code: string };

/** Everything the check touches outside itself; each call gets a signal that carries its timeout. */
export interface StagingPorts {
    readonly lookup: (hostname: string, signal: AbortSignal) => Promise<DnsAnswer>;
    readonly probeTls: (hostname: string, signal: AbortSignal) => Promise<TlsProbe>;
    readonly fetch: typeof fetch;
    readonly nowMs: () => number;
}

export interface StagingOptions {
    /** `https://<engineId>.<engine domain>`, origin only. */
    readonly engine: URL;
    readonly engineId: EngineId;
    /** The relay hostnames the engine hostname must resolve to. */
    readonly relays: readonly string[];
    /** The UI release store, `https://` with a trailing slash. */
    readonly releaseUrl: URL;
    /** `name=value` of an owner session; never printed. */
    readonly ownerCookie: string | null;
    /** Per network request, DNS lookup and TLS handshake. */
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
}
