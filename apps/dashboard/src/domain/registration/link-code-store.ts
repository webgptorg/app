import type { EngineId, EngineVersion, RegistrationMode } from '@ptbk/protocol';

import type { LinkCodeId, OrgId, UserId } from '../ids';
import type { EngineRecord } from './engine-store';

/** A link code as stored: only the SHA-256 hex digest of the code, never the code. */
export interface LinkCodeRecord {
    readonly id: LinkCodeId;
    readonly codeHash: string;
    readonly orgId: OrgId;
    readonly createdByUserId: UserId;
    readonly createdAt: number;
    readonly expiresAt: number;
}

export type LinkCodeInsertOutcome = 'inserted' | 'link-code-limit' | 'rate-limited';

/** What a re-registration of an active engine changes: the signed mode and version. */
export interface EngineRefresh {
    readonly engineId: EngineId;
    readonly orgId: OrgId;
    readonly mode: RegistrationMode;
    readonly engineVersion: EngineVersion;
    readonly now: number;
}

/**
 * What became of a code, for the link page. Redemption wins over expiry: a code used before it expired stays `linked`
 * for good, so the page turns to linked even when the engine never received the registration's answer and its retry
 * with the spent code was refused.
 */
export type LinkCodeState =
    | { readonly kind: 'pending'; readonly expiresAt: number }
    | { readonly kind: 'expired' }
    | { readonly kind: 'linked'; readonly engineId: EngineId };

/** An unused code that can still be redeemed, as the owner sees it: never the code or its hash. */
export interface PendingLinkCode {
    readonly id: LinkCodeId;
    readonly createdAt: number;
    readonly expiresAt: number;
}

/** `conflict`: the code or the engine changed since it was read; nothing was written. */
export type Redemption = 'redeemed' | 'conflict';

/**
 * Link codes in D1, looked up by hash for redemption and by ID, within the organization, for their state. A code is
 * redeemable while it is unused and `now < expiresAt`. Redemption marks the code used and writes the engine in one
 * transaction, so a database error never burns a code and two registrations racing for one code cannot both win.
 */
export interface LinkCodeStore {
    /** Checks both organization quotas and inserts the code in one transaction. */
    insert(record: LinkCodeRecord): Promise<LinkCodeInsertOutcome>;
    /** The organization's codes still redeemable at `now`, newest first. */
    listPending(orgId: OrgId, now: number): Promise<readonly PendingLinkCode[]>;
    /**
     * Ends a code that is still redeemable at `now` by moving its expiry to `now`, so it reads as expired and no later
     * registration can win it. `not-found` for a used, expired or unknown code, or one of another organization.
     */
    cancel(orgId: OrgId, id: LinkCodeId, now: number): Promise<'cancelled' | 'not-found'>;
    /** Null for a code of another organization, exactly as for one that does not exist. */
    findState(orgId: OrgId, id: LinkCodeId, now: number): Promise<LinkCodeState | null>;
    /** The organization a redeemable code belongs to: how registration learns the organization. */
    findRedeemable(codeHash: string, now: number): Promise<OrgId | null>;
    /** Consumes the code only if the engine is new and its organization still has capacity. */
    redeemForNewEngine(codeHash: string, engine: EngineRecord, maxActiveEngines: number | null): Promise<Redemption>;
    /** Only if the code is still redeemable for `refresh.orgId` and the engine is active in that organization. */
    redeemForExistingEngine(codeHash: string, refresh: EngineRefresh): Promise<Redemption>;
}
