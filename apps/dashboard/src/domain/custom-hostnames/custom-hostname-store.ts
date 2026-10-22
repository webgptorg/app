import type { Ed25519PublicKey, Ed25519Signature, EngineId, Hostname } from '@ptbk/protocol';

import type { AdminAuditEntry } from '../auth/records';
import type { OrgId, UserId } from '../ids';

export type CustomHostnameStatus = 'pending-dns' | 'active';

/** An `engine_hostnames` row. */
export interface CustomHostnameRecord {
    readonly hostname: Hostname;
    readonly engineId: EngineId;
    readonly orgId: OrgId;
    /** The engine's signature over `signingInput('ptbk-hostname-v1', hostname, engineId)`. */
    readonly claimSig: Ed25519Signature;
    readonly status: CustomHostnameStatus;
    /** When a DNS check last answered `cname` or `none`; null before the first one. */
    readonly dnsCheckedAt: number | null;
    readonly createdAt: number;
    readonly createdByUserId: UserId;
}

/** What adding a hostname needs to know about its engine. */
export interface HostnameEngine {
    readonly orgId: OrgId;
    readonly publicKey: Ed25519PublicKey;
}

/**
 * The platform admin's side of `engine_hostnames` (D-08). Admins act across organizations, so these reads are not
 * scoped by one; the organization-facing read is `EngineHostnameStore`. Every change writes its `admin_audit_log`
 * entry in the same transaction, so no change goes unrecorded.
 */
export interface CustomHostnameStore {
    findEngine(engineId: EngineId): Promise<HostnameEngine | null>;
    /** Oldest first. */
    listForEngine(engineId: EngineId): Promise<readonly CustomHostnameRecord[]>;
    find(engineId: EngineId, hostname: Hostname): Promise<CustomHostnameRecord | null>;
    /** Whether any engine has the hostname, in any status. */
    isAssigned(hostname: Hostname): Promise<boolean>;
    /** `taken` when another write assigned the hostname first; nothing is written then, audit included. */
    insert(record: CustomHostnameRecord, audit: AdminAuditEntry): Promise<'inserted' | 'taken'>;
    /** Stores a definite DNS answer; `audit` is written with it when given (a status change). */
    recordDnsCheck(
        engineId: EngineId,
        hostname: Hostname,
        check: { readonly status: CustomHostnameStatus; readonly checkedAt: number },
        audit: AdminAuditEntry | null,
    ): Promise<'updated' | 'not-found'>;
    remove(engineId: EngineId, hostname: Hostname, audit: AdminAuditEntry): Promise<'removed' | 'not-found'>;
}
