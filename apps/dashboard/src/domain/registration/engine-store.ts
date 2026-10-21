import type { Ed25519PublicKey, EngineId, EngineVersion, Hostname, RegistrationMode } from '@ptbk/protocol';

import type { OrgId } from '../ids';

export type EngineStatus = 'active' | 'suspended';

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
    /**
     * Registration only, and the one unscoped read: the engine ID is the key's hash, so the caller has just proved it
     * holds that key, and must learn whether another organization already has it.
     */
    findForRegistration(engineId: EngineId): Promise<EngineRecord | null>;
}
