import type { Hostname } from '@ptbk/protocol';

export const CT_SOURCES = ['crt.sh', 'certspotter'] as const;
export type CtSourceName = (typeof CT_SOURCES)[number];

/** One certificate issuance as a CT log search shows it; public metadata only. */
export interface CtIssuance {
    /** DNS names, lower-case, without duplicates. */
    readonly hostnames: readonly string[];
    /** The issuer's distinguished name as the source gives it, e.g. `C=US, O=Let's Encrypt, CN=R11`. */
    readonly issuer: string;
    /** Start of validity, milliseconds since the Unix epoch. */
    readonly notBefore: number;
}

export interface CtPage {
    readonly issuances: readonly CtIssuance[];
    /** Where the next read starts, saved only after the issuances were stored; null: nothing to remember yet. */
    readonly cursor: string | null;
}

/** A CT search service (crt.sh, Cert Spotter). Two of them, so one being down only degrades the watch. */
export interface CtLogSource {
    readonly name: CtSourceName;
    /** Issuances for `domain` and every name under it, newer than `cursor` (null: whatever the source still has). */
    read(domain: Hostname, cursor: string | null, signal: AbortSignal): Promise<CtPage>;
}
