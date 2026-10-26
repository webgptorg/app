import type { CtSourceName } from './ct-log-source';

export type CtAlertReason = 'wildcard' | 'foreign-issuer' | 'unknown-hostname';

/** A `ct_certs` row. */
export interface CtCertRecord {
    readonly issuanceSha256: string;
    readonly source: CtSourceName;
    readonly firstSeenAt: number;
    readonly notBefore: number;
    readonly hostnames: readonly string[];
    readonly issuer: string;
    readonly alert: readonly CtAlertReason[];
}

/** The CT watch's state in D1: what it has seen, and where each source's next read starts. */
export interface CtStore {
    cursor(source: CtSourceName): Promise<string | null>;
    saveCursor(source: CtSourceName, cursor: string): Promise<void>;
    /** Which of `keys` are stored already. */
    known(keys: readonly string[]): Promise<ReadonlySet<string>>;
    /** Skips a key that is there already. */
    insert(records: readonly CtCertRecord[]): Promise<void>;
    /** Which of `hostnames` are an engine's default hostname, in any status. */
    registeredHostnames(hostnames: readonly string[]): Promise<ReadonlySet<string>>;
    /** Certificates issued (`notBefore`) at or after `since` that name `hostname`. */
    countIssuedSince(hostname: string, since: number): Promise<number>;
    /** Forgets certificates first seen before `before`. */
    prune(before: number): Promise<void>;
}
