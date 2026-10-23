import type { EngineId } from '@ptbk/protocol';

import type { AdminAuditEntry } from '../auth/records';
import type { EngineRecord } from '../registration/engine-store';

export type PlatformSuspendOutcome = 'suspended' | 'already-suspended' | 'not-found';
export type PlatformUnsuspendOutcome = 'unsuspended' | 'not-suspended' | 'owner-revoked' | 'not-found';

/**
 * Engines as a platform admin sees them (I-05): across organizations, so not scoped by one, and only behind the
 * `admin.engine.*` actions. Each change writes its `admin_audit_log` entry in the same transaction, and only when the
 * engine actually changes.
 */
export interface PlatformEngineStore {
    find(engineId: EngineId): Promise<EngineRecord | null>;
    /** An active engine only; a suspended one (by the platform or revoked by its owner) stays as it is. */
    suspend(engineId: EngineId, audit: AdminAuditEntry): Promise<PlatformSuspendOutcome>;
    /** A platform suspension only: an owner revocation is permanent and answers `owner-revoked`. */
    unsuspend(engineId: EngineId, audit: AdminAuditEntry): Promise<PlatformUnsuspendOutcome>;
}
