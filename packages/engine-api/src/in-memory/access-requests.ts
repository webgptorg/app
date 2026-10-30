import { AccessRequest, ACCESS_REQUEST_TTL_MS, MAX_PENDING_ACCESS_REQUESTS } from '../capabilities/access-requests';
import { AccessRequestId, DashboardUserId, MemberId, PasskeyId } from '../common';
import type { Member } from '../members';
import type { Passkey } from '../passkeys';
import { fail, notFound, ok, page, sortBy, time } from './kit';
import type { EngineContext, Handlers } from './kit';
import type { InMemoryState } from './state';

/** A pending request as the engine keeps it: the code and the passkey stay here, never in a response. */
export interface AccessRequestRecord {
    readonly request: AccessRequest;
    readonly code: string;
    readonly dashboardUserId: DashboardUserId;
    readonly passkey: Pick<Passkey, 'name' | 'authenticator'>;
}

export interface NewAccessRequest {
    readonly dashboardUserId: string;
    readonly displayName: string;
    readonly email: string;
    readonly proposedRole: AccessRequest['proposedRole'];
    readonly code: string;
    readonly passkey?: Pick<Passkey, 'name' | 'authenticator'>;
}

export type DashboardRevocationOutcome = 'revoked' | 'refused-owner' | 'refused-disabled' | 'not-found';

function dropExpired(ctx: EngineContext): void {
    const now = time(ctx.now());
    for (const [id, record] of ctx.state.accessRequests) {
        if (time(record.request.expiresAt) <= now) ctx.state.accessRequests.delete(id);
    }
}

export function activeOwnerCount(state: InMemoryState): number {
    let owners = 0;
    for (const member of state.members.values()) if (member.role === 'owner' && member.status === 'active') owners++;
    return owners;
}

/** Ends everything a removed member could still use: their sessions and passkeys. */
export function signOutEverywhere(state: InMemoryState, memberId: string): void {
    for (const session of [...state.sessions.values()]) {
        if (session.memberId === memberId) state.sessions.delete(session.id);
    }
    for (const passkey of [...state.passkeys.values()]) {
        if (passkey.memberId === memberId) state.passkeys.delete(passkey.id);
    }
}

/** What the gateway's join page does once the ticket checked out: throws when the engine is at its pending cap. */
export function requestAccess(ctx: EngineContext, input: NewAccessRequest): AccessRequest {
    dropExpired(ctx);
    if (ctx.state.accessRequests.size >= MAX_PENDING_ACCESS_REQUESTS) throw new Error('too many pending requests');
    const dashboardUserId = DashboardUserId.parse(input.dashboardUserId);
    // A second ticket for the same person replaces their earlier request instead of piling up.
    for (const [id, record] of ctx.state.accessRequests) {
        if (record.dashboardUserId === dashboardUserId) ctx.state.accessRequests.delete(id);
    }
    const createdAt = ctx.now();
    const request = AccessRequest.parse({
        id: ctx.newId(AccessRequestId, 'access'),
        displayName: input.displayName,
        email: input.email,
        proposedRole: input.proposedRole,
        createdAt,
        expiresAt: new Date(time(createdAt) + ACCESS_REQUEST_TTL_MS).toISOString(),
    });
    ctx.state.accessRequests.set(request.id, {
        request,
        code: input.code,
        dashboardUserId,
        passkey: input.passkey ?? { name: 'Passkey', authenticator: null },
    });
    return request;
}

/** A signed revocation from the dashboard, after its signature checked out. */
export function revokeDashboardMember(ctx: EngineContext, dashboardUserId: string): DashboardRevocationOutcome {
    for (const [id, record] of ctx.state.accessRequests) {
        if (record.dashboardUserId === dashboardUserId) ctx.state.accessRequests.delete(id);
    }
    if (ctx.state.settings.dashboardRemovals === false) return 'refused-disabled';
    const member = [...ctx.state.members.values()].find(
        (candidate) => candidate.dashboardUserId === dashboardUserId && candidate.status === 'active',
    );
    if (member === undefined) return 'not-found';
    if (member.role === 'owner' && activeOwnerCount(ctx.state) <= 1) return 'refused-owner';
    ctx.state.members.set(member.id, { ...member, status: 'disabled' });
    signOutEverywhere(ctx.state, member.id);
    return 'revoked';
}

export const ACCESS_REQUEST_HANDLERS: Pick<
    Handlers,
    'listAccessRequests' | 'approveAccessRequest' | 'declineAccessRequest' | 'setDashboardRemovals'
> = {
    listAccessRequests: ({ query }, ctx) => {
        dropExpired(ctx);
        return page(
            [...ctx.state.accessRequests.values()].map(({ request }) => request),
            sortBy('createdAt', (request) => time(request.createdAt)),
            query,
        );
    },
    approveAccessRequest: ({ params, body }, ctx) => {
        dropExpired(ctx);
        const record = ctx.state.accessRequests.get(params.accessRequestId);
        if (record === undefined) return notFound('access request');
        if (record.code !== body.code) return fail('access-code-mismatch');
        ctx.state.accessRequests.delete(record.request.id);
        const at = ctx.now();
        const member: Member = {
            id: ctx.newId(MemberId, 'member'),
            displayName: record.request.displayName,
            role: body.role,
            status: 'active',
            createdAt: at,
            lastSeenAt: null,
            passkeyCount: 1,
            dashboardUserId: record.dashboardUserId,
        };
        ctx.state.members.set(member.id, member);
        const passkey: Passkey = {
            id: ctx.newId(PasskeyId, 'passkey'),
            memberId: member.id,
            name: record.passkey.name,
            createdAt: at,
            lastUsedAt: null,
            authenticator: record.passkey.authenticator,
        };
        ctx.state.passkeys.set(passkey.id, passkey);
        return ok(member);
    },
    declineAccessRequest: ({ params }, ctx) =>
        ctx.state.accessRequests.delete(params.accessRequestId) ? ok(null) : notFound('access request'),
    setDashboardRemovals: ({ body }, ctx) => {
        ctx.state.settings = { ...ctx.state.settings, dashboardRemovals: body.enabled };
        return ok({ enabled: body.enabled });
    },
};
