import type { OrgId, UserId } from '../ids';
import type {
    AdminAuditEntry,
    ChallengeRecord,
    EmailTokenPurpose,
    EmailTokenRecord,
    MembershipRecord,
    MembershipView,
    OrganizationRecord,
    PasskeyRecord,
    SessionRecord,
    UserRecord,
} from './records';

export interface AccountStore {
    findUser(userId: UserId): Promise<UserRecord | null>;
    findUserByEmail(email: string): Promise<UserRecord | null>;
    /** Org-scoped: null unless `userId` is a member of `orgId`. */
    findMembership(orgId: OrgId, userId: UserId): Promise<MembershipView | null>;
    listMemberships(userId: UserId): Promise<readonly MembershipView[]>;
    /** User, personal organization, owner membership, first passkey and first session, all or nothing. */
    createAccount(input: {
        readonly user: UserRecord;
        readonly org: OrganizationRecord;
        readonly membership: MembershipRecord;
        readonly passkey: PasskeyRecord;
        readonly session: SessionRecord;
    }): Promise<'created' | 'conflict'>;
    /** Adds the recovery passkey, revokes every session of the user, sets `recovered_at` and starts a session, atomically. */
    recoverAccount(input: {
        readonly userId: UserId;
        readonly passkey: PasskeyRecord;
        readonly session: SessionRecord;
        readonly recoveredAt: number;
    }): Promise<'recovered' | 'conflict'>;
}

export interface PasskeyStore {
    find(credentialId: string): Promise<PasskeyRecord | null>;
    listForUser(userId: UserId): Promise<readonly PasskeyRecord[]>;
    add(passkey: PasskeyRecord): Promise<'added' | 'conflict'>;
    recordUse(userId: UserId, credentialId: string, counter: number, usedAt: number): Promise<void>;
    flagCounterRegression(userId: UserId, credentialId: string, at: number): Promise<void>;
    /** Never removes a user's last passkey, also under concurrent deletes. */
    deleteUnlessLast(userId: UserId, credentialId: string): Promise<'deleted' | 'not-found' | 'last'>;
}

export interface SessionStore {
    create(session: SessionRecord): Promise<void>;
    find(idHash: string): Promise<SessionRecord | null>;
    touch(idHash: string, lastSeenAt: number): Promise<void>;
    markSteppedUp(idHash: string, at: number): Promise<void>;
    /** Makes `orgId` the session's active organization, only if its user is a member there and it is not revoked. */
    setActiveOrg(idHash: string, orgId: OrgId): Promise<'switched' | 'not-member'>;
    revoke(idHash: string, at: number): Promise<void>;
    revokeAllForUser(userId: UserId, at: number): Promise<void>;
    /** Not revoked and not past the absolute expiry; the caller applies the idle timeout. */
    listActiveForUser(userId: UserId, now: number): Promise<readonly SessionRecord[]>;
}

export interface ChallengeStore {
    /** Also drops expired challenges, so the table only holds live ceremonies. */
    create(challenge: ChallengeRecord, now: number): Promise<void>;
    /** Deletes and returns the challenge in one statement, so it can be used at most once even under concurrency. */
    consume(id: string, now: number): Promise<ChallengeRecord | null>;
}

export interface EmailTokenStore {
    /** Replaces every older token for the same email and purpose, and drops expired tokens. */
    issue(token: EmailTokenRecord): Promise<void>;
    /** A token that is unused and unexpired, without using it. */
    findUsable(tokenHash: string, purpose: EmailTokenPurpose, now: number): Promise<EmailTokenRecord | null>;
    /** Marks the token used in one conditional update and returns it, or null if it was not usable. */
    consume(tokenHash: string, purpose: EmailTokenPurpose, now: number): Promise<EmailTokenRecord | null>;
}

/** Insert only: there is no way to change or remove an entry. */
export interface AdminAuditLog {
    append(entry: AdminAuditEntry): Promise<void>;
}

export interface AuthStore {
    readonly accounts: AccountStore;
    readonly passkeys: PasskeyStore;
    readonly sessions: SessionStore;
    readonly challenges: ChallengeStore;
    readonly emailTokens: EmailTokenStore;
    readonly adminAudit: AdminAuditLog;
}
