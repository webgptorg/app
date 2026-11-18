import type { EngineId } from '@ptbk/protocol';

import type { TeamName } from '../../shared/team-name';
import type { PasskeyRecord, SessionRecord, UserRecord } from '../auth/records';
import type { InviteId, LinkCodeId, OrgAuditEntryId, OrgId, TeamId, UserId } from '../ids';
import type { Locale } from '../locale';
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

/**
 * What the dashboard knows of someone's access to the team's engine: `none` until they open it, `waiting` once a ticket
 * went out, `approved` once the engine acked it. The engine stays the authority; this is only what it told us.
 */
export type MemberAccess = 'none' | 'waiting' | 'approved';

export interface TeamPersonRecord extends PersonRecord {
    readonly access: MemberAccess;
}

export interface TicketRecord {
    /** The ticket's `ticketId`. */
    readonly id: string;
    readonly teamId: TeamId;
    readonly engineId: EngineId;
    readonly userId: UserId;
    readonly issuedAt: number;
    readonly expiresAt: number;
}

export type TicketOutcome = 'approved' | 'declined' | 'removed';

/** What an applied ticket ack changed, for the email it may cause. */
export interface TicketAckEffect {
    readonly orgId: OrgId;
    readonly teamId: TeamId;
    readonly teamName: TeamName;
    readonly userId: UserId;
    readonly email: string;
    readonly locale: Locale;
}

/** A ticket whose request the engine may now be holding, and who should hear of it. */
export interface TicketNotice {
    readonly ticketId: string;
    readonly orgId: OrgId;
    readonly teamId: TeamId;
    readonly teamName: TeamName;
    readonly requesterEmail: string;
    /** The person who invited the requester, and the org owners and admins in the team; never the requester. */
    readonly recipients: readonly { readonly email: string; readonly locale: Locale }[];
}

export const REFUSED_REMOVAL_OUTCOMES = ['refused-disabled', 'refused-owner'] as const;
export type RefusedRemovalOutcome = (typeof REFUSED_REMOVAL_OUTCOMES)[number];

export interface RefusedRemovalRecord extends PersonRecord {
    readonly outcome: RefusedRemovalOutcome;
}

export interface PendingRevocation {
    readonly id: string;
    readonly userId: UserId;
    readonly createdAt: number;
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

/** A pending invitation offered to its address after sign-in (D-33), with who sent it. */
export interface InviteOffer extends InvitePreview {
    /** Null if the inviter's account is gone. */
    readonly inviterEmail: string | null;
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

    listMembers(orgId: OrgId, teamId: TeamId): Promise<readonly TeamPersonRecord[]>;
    /** People taken out of the team whose removal the team's engine has not acked yet. */
    listRemoving(orgId: OrgId, teamId: TeamId): Promise<readonly PersonRecord[]>;
    /**
     * People taken out of the team whose latest removal the engine refused, so they can still use it. They leave the
     * list once someone removes them on the engine (its ticket ack `removed`) or adds them back.
     */
    listRefused(orgId: OrgId, teamId: TeamId): Promise<readonly RefusedRemovalRecord[]>;
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
    /**
     * The team a link code's engine joins; the code must be the organization's and still unused. A team waits for one
     * engine, so the team's other codes still redeemable at `now` end then, as a cancelled code does.
     */
    attachLinkCode(
        orgId: OrgId,
        linkCodeId: LinkCodeId,
        teamId: TeamId,
        now: number,
    ): Promise<'attached' | 'not-found'>;
    /**
     * Binds a newly registered engine to the team its link code named, or else to a new team `fallback` with the
     * code's creator in it. Idempotent: an engine already bound keeps its team.
     */
    bindNewEngine(
        engineId: EngineId,
        fallback: { readonly teamId: TeamId; readonly name: TeamName; readonly at: number },
    ): Promise<void>;

    /** Records a ticket the dashboard signed; the person's access becomes `waiting` unless already `approved`. */
    recordTicket(ticket: TicketRecord): Promise<void>;
    /**
     * Applies the engine's ack of a ticket it was sent: `approved` grants, `declined` resets, `removed` (later, when the
     * engine removed that member) drops the person from the team without a revocation. Null for a ticket of another
     * engine, one never issued, or an ack already applied.
     */
    applyTicketAck(
        engineId: EngineId,
        ticketId: string,
        outcome: TicketOutcome,
        at: number,
    ): Promise<TicketAckEffect | null>;
    /** Unresolved tickets of the engine nobody was told about yet, issued after `since`. */
    ticketsAwaitingNotice(engineId: EngineId, since: number): Promise<readonly TicketNotice[]>;
    markNoticed(ticketIds: readonly string[], at: number): Promise<void>;
    /** Unacked revocations of the engine, oldest first. */
    pendingRevocations(engineId: EngineId, limit: number): Promise<readonly PendingRevocation[]>;
    /** Closes a revocation the engine acked; one of another engine or already closed stays as it is. */
    closeRevocation(engineId: EngineId, revocationId: string, outcome: string, at: number): Promise<void>;

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
    /** Pending invitations to `email` (lowercase) across organizations, newest first. */
    listInvitesForEmail(email: string, now: number): Promise<readonly InviteOffer[]>;
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
    /**
     * {@link acceptInvite} for someone without an account: creates the user with the invitation's address, their
     * passkey, and a session in the invitation's organization, in the same transaction. Nothing is written unless the
     * invitation is still pending and of `session.activeOrgId`; `conflict` when the address or passkey is taken.
     */
    acceptInviteAsNewUser(
        tokenHash: string,
        account: NewInvitedAccount,
        audit: Omit<TeamAudit, 'actorUserId'>,
    ): Promise<{ readonly kind: 'accepted'; readonly orgId: OrgId } | { readonly kind: 'invalid' | 'conflict' }>;
}

/** The account an invitation creates; its address is the invitation's, so it is not given here. */
export interface NewInvitedAccount {
    readonly user: Omit<UserRecord, 'email'>;
    readonly passkey: PasskeyRecord;
    readonly session: SessionRecord;
}
