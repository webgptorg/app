import type { AccountStore } from '../auth/auth-store';
import type { EmailAddress } from '../auth/email-address';
import { newSecret, sha256Hex } from '../auth/secrets';
import { newInviteId, newOrgAuditEntryId, type InviteId, type OrgId, type TeamId, type UserId } from '../ids';
import type { Locale } from '../locale';
import type { EmailMessage, EmailSender } from '../ports/email-sender';
import type { OrgRole } from '../roles';
import type { InvitePreview, InviteRecord } from './team-store';
import { teamAudit, type TeamActor, type TeamDeps } from './teams';

/** How long an emailed invitation works (teams spec): long enough for a colleague on holiday, then it lapses. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_INVITES_PER_REQUEST = 20;

export interface InviteDeps extends TeamDeps {
    readonly accounts: Pick<AccountStore, 'findUserByEmail' | 'findMembership'>;
    readonly email: EmailSender;
    readonly inviteLink: (token: string) => string;
}

/** Who sends the invitations, as the email names them: the session's own user and organization. */
export interface Inviter extends TeamActor {
    readonly email: string;
    /** Null for an organization without a name, e.g. a personal one. */
    readonly orgName: string | null;
}

export interface InviteRequest {
    readonly emails: readonly EmailAddress[];
    readonly role: OrgRole;
    readonly teamIds: readonly TeamId[];
    /** For people without an account yet; people with one get theirs. */
    readonly locale: Locale;
}

export interface InviteResult {
    readonly email: EmailAddress;
    readonly outcome: 'invited' | 'added';
}

export type CreateInvitesOutcome =
    | {
          readonly kind: 'ok';
          readonly results: readonly InviteResult[];
          /** Sends the emails; run after the response, like every other email. */
          readonly deliver: (signal: AbortSignal) => Promise<void>;
      }
    | { readonly kind: 'forbidden' | 'team-not-found' };

async function inviteEmail(
    deps: InviteDeps,
    inviter: Inviter,
    invite: InviteRecord,
    token: string,
    fallbackLocale: Locale,
): Promise<EmailMessage> {
    const recipient = await deps.accounts.findUserByEmail(invite.email);
    const teams = await deps.teams.list(inviter.orgId);
    return {
        template: 'team-invite',
        to: invite.email,
        locale: recipient?.locale ?? fallbackLocale,
        inviterEmail: inviter.email,
        orgName: inviter.orgName,
        teamNames: teams.filter((team) => invite.teamIds.includes(team.id)).map((team) => team.name),
        expiresAt: invite.expiresAt,
        link: deps.inviteLink(token),
    };
}

/**
 * Invites people to the organization and some of its teams. Someone already in the organization is added to the teams
 * at once, without an email: they need no invitation to an organization they are in. Only an owner may invite owners.
 */
export async function createInvites(
    deps: InviteDeps,
    actor: Inviter,
    request: InviteRequest,
): Promise<CreateInvitesOutcome> {
    if (request.role === 'owner' && actor.orgRole !== 'owner') {
        return { kind: 'forbidden' };
    }
    const teams = await Promise.all(request.teamIds.map((teamId) => deps.teams.find(actor.orgId, teamId)));
    if (teams.some((team) => team === null)) {
        return { kind: 'team-not-found' };
    }
    const results: InviteResult[] = [];
    const emails: { readonly invite: InviteRecord; readonly token: string }[] = [];
    for (const email of new Set(request.emails)) {
        const user = await deps.accounts.findUserByEmail(email);
        if (user !== null && (await deps.accounts.findMembership(actor.orgId, user.id)) !== null) {
            for (const teamId of request.teamIds) {
                await deps.teams.addMember(actor.orgId, teamId, user.id, teamAudit(deps, actor));
            }
            results.push({ email, outcome: 'added' });
            continue;
        }
        const token = newSecret(deps.random);
        const now = deps.clock.nowMs();
        const invite: InviteRecord = {
            id: newInviteId(deps.random),
            tokenHash: await sha256Hex(token),
            orgId: actor.orgId,
            email,
            role: request.role,
            teamIds: [...request.teamIds],
            invitedByUserId: actor.userId,
            createdAt: now,
            expiresAt: now + INVITE_TTL_MS,
        };
        await deps.teams.insertInvite(invite, teamAudit(deps, actor));
        emails.push({ invite, token });
        results.push({ email, outcome: 'invited' });
    }
    deps.logger.info('invites.created', { count: emails.length });
    return {
        kind: 'ok',
        results,
        deliver: async (signal) => {
            for (const { invite, token } of emails) {
                await deps.email.send(await inviteEmail(deps, actor, invite, token, request.locale), signal);
            }
        },
    };
}

/** A fresh link for a pending invitation; the old one stops working. */
export async function resendInvite(
    deps: InviteDeps,
    actor: Inviter,
    inviteId: InviteId,
    locale: Locale,
): Promise<
    { readonly kind: 'ok'; readonly deliver: (signal: AbortSignal) => Promise<void> } | { readonly kind: 'not-found' }
> {
    const token = newSecret(deps.random);
    const now = deps.clock.nowMs();
    const invite = await deps.teams.renewInvite(
        actor.orgId,
        inviteId,
        { tokenHash: await sha256Hex(token), expiresAt: now + INVITE_TTL_MS, now },
        teamAudit(deps, actor),
    );
    if (invite === null) {
        return { kind: 'not-found' };
    }
    return {
        kind: 'ok',
        deliver: async (signal) => {
            await deps.email.send(await inviteEmail(deps, actor, invite, token, locale), signal);
        },
    };
}

export function revokeInvite(deps: InviteDeps, actor: TeamActor, inviteId: InviteId) {
    return deps.teams.revokeInvite(actor.orgId, inviteId, teamAudit(deps, actor));
}

export async function previewInvite(
    deps: Pick<InviteDeps, 'teams' | 'clock'>,
    token: string,
): Promise<InvitePreview | null> {
    return deps.teams.previewInvite(await sha256Hex(token), deps.clock.nowMs());
}

export type AcceptOutcome =
    | { readonly kind: 'accepted'; readonly orgId: OrgId }
    | { readonly kind: 'invalid' }
    /** The invitation was for another address: a forwarded link does not let someone else in. */
    | { readonly kind: 'email-mismatch' };

export async function acceptInvite(
    deps: Pick<InviteDeps, 'teams' | 'clock' | 'random'>,
    actor: { readonly userId: UserId; readonly email: string },
    token: string,
): Promise<AcceptOutcome> {
    const tokenHash = await sha256Hex(token);
    const now = deps.clock.nowMs();
    const preview = await deps.teams.previewInvite(tokenHash, now);
    if (preview === null) {
        return { kind: 'invalid' };
    }
    if (preview.invite.email !== actor.email.toLowerCase()) {
        return { kind: 'email-mismatch' };
    }
    return deps.teams.acceptInvite(tokenHash, actor.userId, { id: newOrgAuditEntryId(deps.random), at: now });
}
