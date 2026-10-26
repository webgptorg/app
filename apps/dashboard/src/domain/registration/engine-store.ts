import type { Ed25519PublicKey, EngineId, EngineVersion, Hostname, RegistrationMode } from '@ptbk/protocol';

import type { OrgAuditEntryId, OrgId, UserId } from '../ids';

export type EngineStatus = 'active' | 'suspended';

/** `status_reason` of an engine its owner revoked (D-06): permanent, and never lifted by an admin unsuspend (I-05). */
export const OWNER_REVOKED = 'owner-revoked';

/** `status_reason` of an engine a platform admin suspended (I-05); the admin's own words go to the audit log only. */
export const PLATFORM_SUSPENDED = 'platform-suspended';

/** The `org_audit_log` entry a revocation writes with it. */
export interface RevocationAudit {
    readonly id: OrgAuditEntryId;
    readonly actorUserId: UserId;
    readonly at: number;
}

export type RevokeOutcome = 'revoked' | 'already-revoked' | 'not-found';

/** A registered engine: its key and what derives from it, the mode and version it signed, and our status for it. */
export interface EngineRecord {
    readonly engineId: EngineId;
    readonly orgId: OrgId;
    readonly publicKey: Ed25519PublicKey;
    readonly hostname: Hostname;
    readonly mode: RegistrationMode;
    readonly engineVersion: EngineVersion;
    readonly status: EngineStatus;
    /** Why a suspended engine is suspended, e.g. revoked by its owner (D-06) or by a platform admin (I-05). */
    readonly statusReason: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
}

/** Engines in D1. Organization-facing reads take the `orgId` first and never see another organization's engines. */
export interface EngineStore {
    /** Engines of the organization that count against `engines.max`. */
    countActive(orgId: OrgId): Promise<number>;
    /** The organization's engines, oldest first. */
    listForOrg(orgId: OrgId): Promise<readonly EngineRecord[]>;
    /** Null for an engine of another organization, exactly as for one that does not exist. */
    findInOrg(orgId: OrgId, engineId: EngineId): Promise<EngineRecord | null>;
    /**
     * Suspends the engine with {@link OWNER_REVOKED} and appends the `engine.revoke` audit entry, all or nothing. An
     * engine its owner already revoked stays as it is and gets no second entry.
     */
    revoke(orgId: OrgId, engineId: EngineId, audit: RevocationAudit): Promise<RevokeOutcome>;
    /**
     * Registration only, and the one unscoped read: the engine ID is the key's hash, so the caller has just proved it
     * holds that key, and must learn whether another organization already has it.
     */
    findForRegistration(engineId: EngineId): Promise<EngineRecord | null>;
}
