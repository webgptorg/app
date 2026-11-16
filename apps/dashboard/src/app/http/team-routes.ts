import type { Hono } from 'hono';

import { emailAddressSchema, type EmailAddress } from '../../domain/auth/email-address';
import { inviteIdSchema, teamIdSchema, userIdSchema } from '../../domain/ids';
import { resolveRequestLocale } from '../i18n/resolve-request-locale';
import { issueLinkCode } from '../../domain/registration/issue-link-code';
import type { EngineCreationPolicy } from '../../domain/registration/engine-creation-policy';
import {
    acceptInvite,
    createInvites,
    previewInvite,
    resendInvite,
    revokeInvite,
    type InviteDeps,
    type Inviter,
} from '../../domain/teams/invites';
import type { ActiveSession } from '../../domain/auth/account';
import { changeOrgRole, leaveOrg, removeFromOrg } from '../../domain/teams/people';
import { issueAccessTicket, type MemberAccessDeps } from '../../domain/teams/member-access';
import type { InviteRecord, TeamRecord } from '../../domain/teams/team-store';
import {
    addTeamMember,
    createTeam,
    deleteTeam,
    findVisibleTeam,
    listTeamMembers,
    listTeams,
    removeTeamMember,
    renameTeam,
    type TeamActor,
} from '../../domain/teams/teams';
import { createInviteJoinFlow } from '../../domain/teams/join-invite';
import { apiRoutes, type InviteView, type TeamView } from '../../shared/api/routes';
import { clearInviteCookie, INVITE_COOKIE_TTL_MS, inviteCookie, inviteToken } from './cookies';
import type { DashboardDeps } from '../deps';
import { issuedLinkCodeView } from './link-code-view';
import type { RequestContext, RouteBinder } from './bind-route';

const NO_CONTENT = { kind: 'ok', body: undefined, status: 204 } as const;
/** The engine's join gateway page (teams spec, "Adding a person"), under its reserved `/auth/` prefix. */
const JOIN_PATH = '/auth/join';

export function memberAccessDeps(
    deps: Pick<DashboardDeps, 'teams' | 'engines' | 'memberKey' | 'clock' | 'random' | 'logger'>,
): MemberAccessDeps {
    return deps;
}
const NOT_FOUND = { kind: 'problem', status: 404, code: 'not-found' } as const;
const LAST_OWNER = { kind: 'problem', status: 409, code: 'last-owner' } as const;

function requestLocale(request: RequestContext) {
    return resolveRequestLocale({
        userLocale: null,
        cookieHeader: request.header('cookie'),
        acceptLanguage: request.header('accept-language'),
    });
}

function inviteView(invite: InviteRecord): InviteView {
    return {
        inviteId: invite.id,
        email: invite.email,
        role: invite.role,
        teamIds: [...invite.teamIds],
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
    };
}

async function teamView(deps: Pick<DashboardDeps, 'teams'>, actor: TeamActor, team: TeamRecord): Promise<TeamView> {
    return {
        teamId: team.id,
        name: team.name,
        engineId: team.engineId,
        memberCount: team.memberCount,
        isMember: await deps.teams.isMember(actor.orgId, team.id, actor.userId),
        createdAt: team.createdAt,
    };
}

/**
 * Teams, the organization's people and invitations (ADR 0018). The organization is always the session's active one;
 * a team a member may not see answers exactly as one that does not exist.
 */
export function bindTeamRoutes(
    router: Hono,
    mount: string,
    deps: DashboardDeps & { readonly policy: EngineCreationPolicy; readonly routes: RouteBinder },
): void {
    const bind = deps.routes.bind.bind(deps.routes);
    const inviteDeps: InviteDeps = {
        ...deps,
        accounts: deps.store.accounts,
        inviteLink: (token) => deps.links.invite(token),
    };

    bind(router, mount, apiRoutes.listTeams, async ({ session }) => {
        const teams = await listTeams(deps, session.actor);
        return {
            kind: 'ok',
            body: { teams: await Promise.all(teams.map((team) => teamView(deps, session.actor, team))) },
        };
    });

    bind(router, mount, apiRoutes.createTeam, async ({ input, session }) => {
        const team = await createTeam(deps, session.actor, input.body.name);
        return { kind: 'ok', body: { team: await teamView(deps, session.actor, team) } };
    });

    bind(router, mount, apiRoutes.getTeam, async ({ input, session }) => {
        const teamId = teamIdSchema.parse(input.params.teamId);
        const team = await findVisibleTeam(deps, session.actor, teamId);
        const members = await listTeamMembers(deps, session.actor, teamId);
        if (team === null || members === null) {
            return NOT_FOUND;
        }
        const [removing, refused, invites] = await Promise.all([
            deps.teams.listRemoving(session.actor.orgId, teamId),
            deps.teams.listRefused(session.actor.orgId, teamId),
            deps.teams.listPendingInvites(session.actor.orgId, deps.clock.nowMs()),
        ]);
        return {
            kind: 'ok',
            body: {
                team: await teamView(deps, session.actor, team),
                members: [...members],
                removing: [...removing],
                refused: [...refused],
                invites: invites.filter((invite) => invite.teamIds.includes(teamId)).map(inviteView),
            },
        };
    });

    bind(router, mount, apiRoutes.renameTeam, async ({ input, session }) => {
        const teamId = teamIdSchema.parse(input.params.teamId);
        if ((await renameTeam(deps, session.actor, teamId, input.body.name)) === 'not-found') {
            return NOT_FOUND;
        }
        const team = await deps.teams.find(session.actor.orgId, teamId);
        return team === null ? NOT_FOUND : { kind: 'ok', body: { team: await teamView(deps, session.actor, team) } };
    });

    bind(router, mount, apiRoutes.deleteTeam, async ({ input, session }) => {
        const outcome = await deleteTeam(deps, session.actor, teamIdSchema.parse(input.params.teamId));
        return outcome === 'deleted' ? NO_CONTENT : NOT_FOUND;
    });

    bind(router, mount, apiRoutes.createTeamLinkCode, async ({ input, request, session }) => {
        const team = await deps.teams.find(session.actor.orgId, teamIdSchema.parse(input.params.teamId));
        if (team === null) {
            return NOT_FOUND;
        }
        if (team.engineId !== null) {
            return { kind: 'problem', status: 409, code: 'team-has-engine' };
        }
        const outcome = await issueLinkCode(
            { ...deps, linkCodeTtlMs: deps.config.linkCodeTtlMs },
            { orgId: session.actor.orgId, userId: session.actor.userId },
            request.signal,
        );
        if (outcome.kind === 'denied') {
            switch (outcome.reason) {
                case 'not-entitled':
                case 'engine-limit':
                    return { kind: 'problem', status: 403, code: outcome.reason };
                case 'link-code-limit':
                    return { kind: 'problem', status: 409, code: 'link-code-limit' };
                case 'rate-limited':
                    return { kind: 'problem', status: 429, code: 'rate-limited' };
            }
        }
        await deps.teams.attachLinkCode(session.actor.orgId, outcome.linkCodeId, team.id, deps.clock.nowMs());
        return {
            kind: 'ok',
            body: issuedLinkCodeView(deps.config, outcome),
        };
    });

    bind(router, mount, apiRoutes.createAccessTicket, async ({ input, session }) => {
        const outcome = await issueAccessTicket(
            memberAccessDeps(deps),
            { ...session.actor, email: session.user.email },
            teamIdSchema.parse(input.params.teamId),
        );
        switch (outcome.kind) {
            case 'issued':
                return {
                    kind: 'ok',
                    body: {
                        url: `https://${outcome.hostname}${JOIN_PATH}#${outcome.ticket}`,
                        expiresAt: outcome.expiresAt,
                    },
                };
            case 'direct':
                return { kind: 'ok', body: { url: `https://${outcome.hostname}/`, expiresAt: null } };
            case 'not-found':
                return NOT_FOUND;
            case 'unavailable':
                return { kind: 'problem', status: 503, code: 'unavailable' };
        }
    });

    bind(router, mount, apiRoutes.addTeamMember, async ({ input, session }) => {
        const outcome = await addTeamMember(
            deps,
            session.actor,
            teamIdSchema.parse(input.params.teamId),
            userIdSchema.parse(input.body.userId),
        );
        switch (outcome) {
            case 'added':
            case 'already':
                return NO_CONTENT;
            case 'not-member':
                return { kind: 'problem', status: 409, code: 'not-member' };
            case 'not-found':
                return NOT_FOUND;
        }
    });

    bind(router, mount, apiRoutes.removeTeamMember, async ({ input, session }) => {
        const outcome = await removeTeamMember(
            deps,
            session.actor,
            teamIdSchema.parse(input.params.teamId),
            userIdSchema.parse(input.params.userId),
        );
        switch (outcome) {
            case 'removed':
                return NO_CONTENT;
            case 'forbidden':
                return { kind: 'problem', status: 403, code: 'forbidden' };
            case 'not-found':
                return NOT_FOUND;
        }
    });

    bind(router, mount, apiRoutes.leaveTeam, async ({ input, session }) => {
        const outcome = await removeTeamMember(
            deps,
            session.actor,
            teamIdSchema.parse(input.params.teamId),
            session.actor.userId,
        );
        return outcome === 'removed' ? NO_CONTENT : NOT_FOUND;
    });

    bind(router, mount, apiRoutes.listOrgMembers, async ({ session }) => {
        const [members, invites] = await Promise.all([
            deps.teams.listOrgMembers(session.actor.orgId),
            deps.teams.listPendingInvites(session.actor.orgId, deps.clock.nowMs()),
        ]);
        return {
            kind: 'ok',
            body: {
                members: members.map((member) => ({ ...member, teamIds: [...member.teamIds] })),
                invites: invites.map(inviteView),
            },
        };
    });

    bind(router, mount, apiRoutes.changeOrgRole, async ({ input, session }) => {
        const outcome = await changeOrgRole(
            deps,
            session.actor,
            userIdSchema.parse(input.params.userId),
            input.body.role,
        );
        switch (outcome) {
            case 'changed':
            case 'unchanged':
                return NO_CONTENT;
            case 'last-owner':
                return LAST_OWNER;
            case 'not-found':
                return NOT_FOUND;
        }
    });

    bind(router, mount, apiRoutes.removeOrgMember, async ({ input, session }) => {
        const outcome = await removeFromOrg(deps, session.actor, userIdSchema.parse(input.params.userId));
        switch (outcome) {
            case 'removed':
                return NO_CONTENT;
            case 'last-owner':
                return LAST_OWNER;
            case 'forbidden':
                return { kind: 'problem', status: 403, code: 'forbidden' };
            case 'not-found':
                return NOT_FOUND;
        }
    });

    // The session moves to another organization of the user's, since it can no longer act in this one.
    bind(router, mount, apiRoutes.leaveOrg, async ({ session }) => {
        const outcome = await leaveOrg(deps, session.actor);
        if (outcome === 'last-owner') {
            return LAST_OWNER;
        }
        const [next] = await deps.store.accounts.listMemberships(session.actor.userId);
        if (next !== undefined) {
            await deps.store.sessions.setActiveOrg(session.record.idHash, next.orgId);
        }
        return NO_CONTENT;
    });

    bind(router, mount, apiRoutes.createInvites, async ({ input, request, session }) => {
        const emails: EmailAddress[] = [];
        for (const raw of input.body.emails) {
            const email = emailAddressSchema.safeParse(raw);
            if (!email.success) {
                return { kind: 'problem', status: 400, code: 'invalid-email' };
            }
            emails.push(email.data);
        }
        const outcome = await createInvites(inviteDeps, inviter(session), {
            emails,
            role: input.body.role,
            teamIds: input.body.teamIds.map((teamId) => teamIdSchema.parse(teamId)),
            locale: requestLocale(request),
        });
        switch (outcome.kind) {
            case 'ok':
                request.waitUntil(sendInBackground(deps, outcome.deliver));
                return { kind: 'ok', body: { results: [...outcome.results] } };
            case 'forbidden':
                return { kind: 'problem', status: 403, code: 'forbidden' };
            case 'team-not-found':
                return { kind: 'problem', status: 404, code: 'team-not-found' };
        }
    });

    bind(router, mount, apiRoutes.resendInvite, async ({ input, request, session }) => {
        const outcome = await resendInvite(
            inviteDeps,
            inviter(session),
            inviteIdSchema.parse(input.params.inviteId),
            requestLocale(request),
        );
        if (outcome.kind === 'not-found') {
            return NOT_FOUND;
        }
        request.waitUntil(sendInBackground(deps, outcome.deliver));
        return NO_CONTENT;
    });

    bind(router, mount, apiRoutes.revokeInvite, async ({ input, session }) => {
        const outcome = await revokeInvite(inviteDeps, session.actor, inviteIdSchema.parse(input.params.inviteId));
        return outcome === 'revoked' ? NO_CONTENT : NOT_FOUND;
    });

    bind(router, mount, apiRoutes.previewInvite, async ({ input, request }) => {
        const token = inviteToken(input.body.token, request);
        const found = token === null ? null : await createInviteJoinFlow(deps).preview(token);
        if (token === null || found === null) {
            return { ...NOT_FOUND, setCookies: [clearInviteCookie()] };
        }
        const { invite, orgName, teamNames } = found.preview;
        const ttlMs = Math.min(INVITE_COOKIE_TTL_MS, invite.expiresAt - deps.clock.nowMs());
        return {
            kind: 'ok',
            body: {
                orgName,
                teamNames: [...teamNames],
                email: invite.email,
                expiresAt: invite.expiresAt,
                hasAccount: found.hasAccount,
            },
            setCookies: [inviteCookie(token, ttlMs)],
        };
    });

    bind(router, mount, apiRoutes.acceptInvite, async ({ input, request, session }) => {
        const token = inviteToken(input.body.token, request);
        const preview = token === null ? null : await previewInvite(deps, token);
        const outcome =
            token === null || preview === null
                ? ({ kind: 'invalid' } as const)
                : await acceptInvite(inviteDeps, { userId: session.user.id, email: session.user.email }, token);
        switch (outcome.kind) {
            case 'accepted':
                return {
                    kind: 'ok',
                    body: { orgId: outcome.orgId, teamIds: [...(preview?.invite.teamIds ?? [])] },
                    setCookies: [clearInviteCookie()],
                };
            case 'invalid':
                return { kind: 'problem', status: 404, code: 'invite-invalid', setCookies: [clearInviteCookie()] };
            case 'email-mismatch':
                return { kind: 'problem', status: 403, code: 'email-mismatch' };
        }
    });
}

function inviter(session: ActiveSession): Inviter {
    return { ...session.actor, email: session.user.email, orgName: session.membership.org.name };
}

const SEND_TIMEOUT_MS = 30_000;

async function sendInBackground(
    deps: Pick<DashboardDeps, 'logger'>,
    deliver: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
    try {
        await deliver(AbortSignal.timeout(SEND_TIMEOUT_MS));
    } catch (error) {
        deps.logger.error('invites.email-failed', { error: error instanceof Error ? error.name : 'unknown' });
    }
}
