import type { EngineId, EngineVersion, RegistrationMode } from '@ptbk/protocol';

import type { OrgId, UserId } from '../ids';
import type { EngineRecord } from './engine-store';

/** A link code as stored: only the SHA-256 hex digest of the code, never the code. */
export interface LinkCodeRecord {
    readonly codeHash: string;
    readonly orgId: OrgId;
    readonly createdByUserId: UserId;
    readonly createdAt: number;
    readonly expiresAt: number;
}

/** What a re-registration of an active engine changes: the signed mode and version. */
export interface EngineRefresh {
    readonly engineId: EngineId;
    readonly orgId: OrgId;
    readonly mode: RegistrationMode;
    readonly engineVersion: EngineVersion;
    readonly now: number;
}

/** `conflict`: the code or the engine changed since it was read; nothing was written. */
export type Redemption = 'redeemed' | 'conflict';

/**
 * Link codes in D1, looked up only by hash. A code is redeemable while it is unused and `now < expiresAt`.
 * Redemption marks the code used and writes the engine in one transaction, so a database error never burns a code and
 * two registrations racing for one code cannot both win.
 */
export interface LinkCodeStore {
    insert(record: LinkCodeRecord): Promise<void>;
    /** Codes of the organization still redeemable at `now`. */
    countActive(orgId: OrgId, now: number): Promise<number>;
    countIssuedSince(orgId: OrgId, since: number): Promise<number>;
    /** The organization a redeemable code belongs to: how registration learns the organization. */
    findRedeemable(codeHash: string, now: number): Promise<OrgId | null>;
    /** Only if the code is still redeemable for `engine.orgId` at `engine.createdAt` and no engine has that ID. */
    redeemForNewEngine(codeHash: string, engine: EngineRecord): Promise<Redemption>;
    /** Only if the code is still redeemable for `refresh.orgId` and the engine is active in that organization. */
    redeemForExistingEngine(codeHash: string, refresh: EngineRefresh): Promise<Redemption>;
}
