import {
    ACCESS_TICKET_MAX_LIFETIME_MS,
    MAX_HEARTBEAT_REVOCATIONS,
    signAccessTicket,
    signMemberRevocation,
    Timestamp,
    type EngineId,
    type HeartbeatAck,
    type HeartbeatReply,
    type HeartbeatV2,
    type Hostname,
} from '@ptbk/protocol';

import { newSecret } from '../auth/secrets';
import type { OrgId, TeamId } from '../ids';
import type { Clock } from '../ports/clock';
import type { EmailMessage } from '../ports/email-sender';
import type { Logger } from '../ports/logger';
import type { Random } from '../ports/random';
import type { EngineStore } from '../registration/engine-store';
import type { UsageEvent } from '../usage/usage-event';
import type { MemberKeySource } from './member-key';
import type { TeamStore, TicketOutcome } from './team-store';
import type { TeamActor } from './teams';

export interface MemberAccessDeps {
    readonly teams: TeamStore;
    readonly engines: Pick<EngineStore, 'findInOrg'>;
    readonly memberKey: MemberKeySource;
    readonly clock: Clock;
    readonly random: Random;
    readonly logger: Logger;
}

export type TicketOutcomeView =
    | {
          readonly kind: 'issued';
          readonly ticket: string;
          readonly engineId: EngineId;
          readonly hostname: Hostname;
          readonly expiresAt: number;
      }
    /** The actor already has access: open the engine itself, no ticket. */
    | { readonly kind: 'direct'; readonly hostname: Hostname }
    /** Not a team of the organization the actor is in, or one without an active engine. */
    | { readonly kind: 'not-found' }
    /** No member key is configured. */
    | { readonly kind: 'unavailable' };

const iso = (ms: number) => Timestamp.parse(new Date(ms).toISOString());

/**
 * A signed ticket that lets the actor ask the team's engine for access (or sign in, once they have it). Only for people
 * in the team: seeing a team in the dashboard is not access to its engine.
 */
export async function issueAccessTicket(
    deps: MemberAccessDeps,
    actor: TeamActor & { readonly email: string },
    teamId: TeamId,
): Promise<TicketOutcomeView> {
    const team = await deps.teams.find(actor.orgId, teamId);
    const engineId = team?.engineId ?? null;
    const engine =
        engineId === null || !(await deps.teams.isMember(actor.orgId, teamId, actor.userId))
            ? null
            : await deps.engines.findInOrg(actor.orgId, engineId);
    if (engine === null || engine.status !== 'active') {
        return { kind: 'not-found' };
    }
    // The engine already has them, or they own it through its setup secret and it has no dashboard ID to match:
    // a ticket would only make them ask themselves for access. Going there grants nothing, the engine still signs in.
    const members = await deps.teams.listMembers(actor.orgId, teamId);
    if (members.some((member) => member.userId === actor.userId && member.access === 'approved')) {
        return { kind: 'direct', hostname: engine.hostname };
    }
    const key = await deps.memberKey();
    if (key === null) {
        return { kind: 'unavailable' };
    }
    const now = deps.clock.nowMs();
    const expiresAt = now + ACCESS_TICKET_MAX_LIFETIME_MS;
    // 256 random bits as base64url: inside the protocol's 16–64 character ticket IDs.
    const ticketId = newSecret(deps.random);
    const ticket = await signAccessTicket(key.signer, {
        v: 1,
        engineId: engine.engineId,
        ticketId,
        dashboardUserId: actor.userId,
        displayName: actor.email,
        email: actor.email,
        proposedRole: actor.orgRole === 'member' ? 'member' : 'admin',
        issuedAt: iso(now),
        expiresAt: iso(expiresAt),
    });
    await deps.teams.recordTicket({
        id: ticketId,
        teamId,
        engineId: engine.engineId,
        userId: actor.userId,
        issuedAt: now,
        expiresAt,
    });
    return { kind: 'issued', ticket, engineId: engine.engineId, hostname: engine.hostname, expiresAt };
}

const TICKET_OUTCOMES: ReadonlySet<string> = new Set<TicketOutcome>(['approved', 'declined', 'removed']);

function isTicketAck(ack: HeartbeatAck): ack is HeartbeatAck & { readonly outcome: TicketOutcome } {
    return TICKET_OUTCOMES.has(ack.outcome);
}

export interface HeartbeatV2Result {
    readonly reply: HeartbeatReply;
    /** The engine's answers to access requests, for the usage record (ADR 0022). */
    readonly usage: readonly UsageEvent[];
    /** The emails the acks and pending requests call for; run after the response. */
    readonly deliver: (send: (message: EmailMessage) => Promise<void>) => Promise<void>;
}

/** How far back a ticket still counts for the waiting-for-approval email: the engine keeps a request 7 days. */
const NOTICE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The dashboard's side of a v2 heartbeat (ADR 0018): applies the engine's acks, notes requests that now wait for
 * approval, and answers with the revocations the engine still owes an ack, signed.
 */
export async function handleHeartbeatV2(
    deps: MemberAccessDeps,
    engineId: EngineId,
    heartbeat: HeartbeatV2,
): Promise<HeartbeatV2Result> {
    const now = deps.clock.nowMs();
    const emails: EmailMessage[] = [];
    const usage: UsageEvent[] = [];
    // Every effect and notice of this heartbeat is about this one engine; heartbeats come only from active ones.
    const engineHostname = async (orgId: OrgId) => (await deps.engines.findInOrg(orgId, engineId))?.hostname ?? null;
    for (const ack of heartbeat.acks) {
        if (!isTicketAck(ack)) {
            await deps.teams.closeRevocation(engineId, ack.id, ack.outcome, now);
            continue;
        }
        const effect = await deps.teams.applyTicketAck(engineId, ack.id, ack.outcome, now);
        if (effect !== null && ack.outcome !== 'removed') {
            usage.push({
                event: ack.outcome === 'approved' ? 'access.approved' : 'access.declined',
                orgId: effect.orgId,
                userId: effect.userId,
                engineId,
                props: {},
            });
        }
        const hostname = effect !== null && ack.outcome === 'approved' ? await engineHostname(effect.orgId) : null;
        if (effect !== null && hostname !== null) {
            emails.push({
                template: 'access-granted',
                to: effect.email,
                locale: effect.locale,
                teamName: effect.teamName,
                hostname,
                link: `https://${hostname}/`,
            });
        }
    }
    if (heartbeat.accessRequests > 0) {
        const notices = await deps.teams.ticketsAwaitingNotice(engineId, now - NOTICE_WINDOW_MS);
        await deps.teams.markNoticed(
            notices.map((notice) => notice.ticketId),
            now,
        );
        for (const notice of notices) {
            const hostname = await engineHostname(notice.orgId);
            if (hostname === null) {
                continue;
            }
            for (const recipient of notice.recipients) {
                emails.push({
                    template: 'access-waiting',
                    to: recipient.email,
                    locale: recipient.locale,
                    requesterEmail: notice.requesterEmail,
                    teamName: notice.teamName,
                    // The engine's Members page, not the request itself: the heartbeat carries only a count and the
                    // engine makes up its request IDs, so the dashboard never knows which one this is.
                    link: `https://${hostname}/members`,
                });
            }
        }
    }
    const key = await deps.memberKey();
    const revocations =
        key === null
            ? []
            : await Promise.all(
                  (await deps.teams.pendingRevocations(engineId, MAX_HEARTBEAT_REVOCATIONS)).map((revocation) =>
                      signMemberRevocation(key.signer, {
                          v: 1,
                          engineId,
                          revocationId: revocation.id,
                          dashboardUserId: revocation.userId,
                          issuedAt: iso(revocation.createdAt),
                      }),
                  ),
              );
    return {
        reply: { v: 1, revocations },
        usage,
        deliver: async (send) => {
            for (const message of emails) {
                await send(message);
            }
        },
    };
}
