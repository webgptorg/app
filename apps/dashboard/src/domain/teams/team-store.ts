import type { EngineId } from '@ptbk/protocol';

import type { TeamName } from '../../shared/team-name';
import type { InviteId, LinkCodeId, OrgAuditEntryId, OrgId, TeamId, UserId } from '../ids';
import type { OrgRole } from '../roles';

/** The `org_audit_log` entry a change writes with it, all or nothing. */
export interface TeamAudit {
    readonly id: OrgAuditEntryId;
    readonly actorUserId: UserId;
    readonly at: number;
}

export interface TeamRecord {
    readonly id: TeamId;
    readonly orgId: OrgId;
    readonly name: TeamName;
    readonly createdAt: number;
    /** At most one in v1 (ADR 0018); null until its engine registers. */
    readonly engineId: EngineId | null;
    readonly memberCount: number;
}

export interface PersonRecord {
    readonly userId: UserId;
    readonly email: string;
    readonly role: OrgRole;
    /** When they joined the team, or the organization for {@link TeamStore.listOrgMembers}. */
    readonly joinedAt: number;
}

export interface OrgMemberRecord extends PersonRecord {
    readonly teamIds: readonly TeamId[];
}

export interface InviteRecord {
    readonly id: InviteId;
    /** SHA-256 of the emailed token. */
    readonly tokenHash: string;
    readonly orgId: OrgId;
    /** Lowercase. */
    readonly email: string;
    readonly role: OrgRole;
    readonly teamIds: readonly TeamId[];
    readonly invitedByUserId: UserId;
    readonly createdAt: number;
    readonly expiresAt: number;
}

/** What the invitation page shows before anyone signs in: names the inviter chose, nothing else. */
export interface InvitePreview {
    readonly invite: InviteRecord;
    readonly orgName: string | null;
    readonly teamNames: readonly TeamName[];
}

/**
 * Why a removal could not happen: the organization keeps at least one owner, so its billing and roles always have
 * someone to run them.
 */
export type LastOwner = 'last-owner';

/**
 * Teams, their people and invitations in D1 (ADR 0018). Every read and write takes the `orgId` first and never sees
 * another organization's rows. Every removal of a person from a team that has an engine queues a member revocation for
 * that engine in the same transaction, so the engine hears of it even if the request dies right after.
 */
export interface TeamStore {
    /** The team, with its creator as the first member. */
    create(team: Omit<TeamRecord, 'engineId' | 'memberCount'>, creator: UserId, audit: TeamAudit): Promise<void>;
    list(orgId: OrgId): Promise<readonly TeamRecord[]>;
    listForUser(orgId: OrgId, userId: UserId): Promise<readonly TeamRecord[]>;
    /** Null for a deleted team or one of another organization, exactly as for one that does not exist. */
    find(orgId: OrgId, teamId: TeamId): Promise<TeamRecord | null>;
    isMember(orgId: OrgId, teamId: TeamId, userId: UserId): Promise<boolean>;
    rename(orgId: OrgId, teamId: TeamId, name: TeamName, audit: TeamAudit): Promise<'renamed' | 'not-found'>;
    /**
     * Marks the team deleted and removes its people, queuing their revocations. Revoking the engine itself is the
     * caller's step, through the engine store, before this.
     */
    delete(orgId: OrgId, teamId: TeamId, audit: TeamAudit): Promise<'deleted' | 'not-found'>;

    listMembers(orgId: OrgId, teamId: TeamId): Promise<readonly PersonRecord[]>;
    /** `not-member`: the user is not in the organization; teams hold only its people. */
    addMember(
        orgId: OrgId,
        teamId: TeamId,
        userId: UserId,
        audit: TeamAudit,
    ): Promise<'added' | 'already' | 'not-found' | 'not-member'>;
    removeMember(orgId: OrgId, teamId: TeamId, userId: UserId, audit: TeamAudit): Promise<'removed' | 'not-found'>;

    /** The engines of the user's teams: what a member may see. */
    engineIdsForUser(orgId: OrgId, userId: UserId): Promise<ReadonlySet<EngineId>>;
    /** The team a link code's engine joins; the code must be the organization's and still unused. */
    attachLinkCode(orgId: OrgId, linkCodeId: LinkCodeId, teamId: TeamId): Promise<'attached' | 'not-found'>;
    /**
     * Binds a newly registered engine to the team its link code named, or else to a new team `fallback` with the
     * code's creator in it. Idempotent: an engine already bound keeps its team.
     */
    bindNewEngine(
        engineId: EngineId,
        fallback: { readonly teamId: TeamId; readonly name: TeamName; readonly at: number },
    ): Promise<void>;

    listOrgMembers(orgId: OrgId): Promise<readonly OrgMemberRecord[]>;
    changeRole(
        orgId: OrgId,
        userId: UserId,
        role: OrgRole,
        audit: TeamAudit,
    ): Promise<'changed' | 'unchanged' | 'not-found' | LastOwner>;
    /** Out of every team of the organization, then out of the organization. */
    removeFromOrg(orgId: OrgId, userId: UserId, audit: TeamAudit): Promise<'removed' | 'not-found' | LastOwner>;

    insertInvite(invite: InviteRecord, audit: TeamAudit): Promise<void>;
    /** Unaccepted, unrevoked and unexpired at `now`, newest first. */
    listPendingInvites(orgId: OrgId, now: number): Promise<readonly InviteRecord[]>;
    /** A pending invitation by its token's hash, with the names to show; null otherwise. */
    previewInvite(tokenHash: string, now: number): Promise<InvitePreview | null>;
    /** A new token and expiry for a pending invitation; the old link stops working. */
    renewInvite(
        orgId: OrgId,
        inviteId: InviteId,
        renewal: { readonly tokenHash: string; readonly expiresAt: number; readonly now: number },
        audit: TeamAudit,
    ): Promise<InviteRecord | null>;
    revokeInvite(orgId: OrgId, inviteId: InviteId, audit: TeamAudit): Promise<'revoked' | 'not-found'>;
    /**
     * Uses a pending invitation for `userId`: membership with the invited role (an existing one keeps its role), the
     * invited teams that still exist, and the invitation spent, all or nothing. `invalid` covers unknown, expired, used
     * and revoked alike.
     */
    acceptInvite(
        tokenHash: string,
        userId: UserId,
        audit: Omit<TeamAudit, 'actorUserId'>,
    ): Promise<{ readonly kind: 'accepted'; readonly orgId: OrgId } | { readonly kind: 'invalid' }>;
}
