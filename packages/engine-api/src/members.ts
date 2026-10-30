import { z } from 'zod';

import { DashboardUserId, InviteId, MemberId, PageQuery, Timestamp, pageOf } from './common';
import { Role } from './permissions';
import { defineRoute } from './route';

export const MEMBER_STATUSES = ['active', 'invited', 'disabled'] as const;

export const Member = z.strictObject({
    id: MemberId,
    displayName: z.string().min(1).max(256),
    role: Role,
    status: z.enum(MEMBER_STATUSES),
    createdAt: Timestamp,
    lastSeenAt: Timestamp.nullable(),
    /** How many passkeys the member has; `null` from engines on API 1.2. */
    passkeyCount: z.int().min(0).nullable().default(null),
    /**
     * The dashboard user this member joined as through an approved access request (since API 1.12), so a signed
     * revocation from the dashboard can find them; `null` for members added any other way and from older engines.
     */
    dashboardUserId: DashboardUserId.nullable().default(null),
});
export type Member = z.infer<typeof Member>;
export const MemberPage = pageOf(Member);

export const MemberParams = z.strictObject({ memberId: MemberId });
export const UpdateMemberBody = z.strictObject({ role: Role });

export const Invite = z.strictObject({
    id: InviteId,
    role: Role,
    createdBy: MemberId,
    createdAt: Timestamp,
    expiresAt: Timestamp,
});
export type Invite = z.infer<typeof Invite>;
export const InvitePage = pageOf(Invite);

export const InviteParams = z.strictObject({ inviteId: InviteId });
export const CreateInviteBody = z.strictObject({ role: Role, expiresAt: Timestamp });
/** `inviteUrl` carries the invite secret and is returned only here, once. */
export const CreateInviteResult = z.strictObject({ invite: Invite, inviteUrl: z.url({ protocol: /^https$/ }) });

export const MEMBER_ROUTES = {
    listMembers: defineRoute({
        id: 'listMembers',
        method: 'GET',
        path: '/members',
        summary: 'List members by display name',
        permission: 'members.read',
        query: PageQuery,
        responses: { 200: { kind: 'json', schema: MemberPage } },
    }),
    getMember: defineRoute({
        id: 'getMember',
        method: 'GET',
        path: '/members/{memberId}',
        summary: 'Get a member',
        permission: 'members.read',
        params: MemberParams,
        responses: { 200: { kind: 'json', schema: Member } },
    }),
    updateMember: defineRoute({
        id: 'updateMember',
        method: 'PATCH',
        path: '/members/{memberId}',
        summary: "Change a member's role; the last owner cannot be demoted",
        permission: 'members.manage',
        params: MemberParams,
        body: { kind: 'json', schema: UpdateMemberBody },
        responses: { 200: { kind: 'json', schema: Member } },
        problems: ['last-owner'],
        stepUp: true,
    }),
    removeMember: defineRoute({
        id: 'removeMember',
        method: 'DELETE',
        path: '/members/{memberId}',
        summary: 'Remove a member and end their sessions; the last owner cannot be removed',
        permission: 'members.manage',
        params: MemberParams,
        responses: { 204: { kind: 'empty' } },
        problems: ['last-owner'],
        stepUp: true,
    }),
    listInvites: defineRoute({
        id: 'listInvites',
        method: 'GET',
        path: '/invites',
        summary: 'List pending invites',
        permission: 'members.read',
        query: PageQuery,
        responses: { 200: { kind: 'json', schema: InvitePage } },
    }),
    createInvite: defineRoute({
        id: 'createInvite',
        method: 'POST',
        path: '/invites',
        summary: 'Invite a member; the invite URL is returned only in this response',
        permission: 'members.manage',
        body: { kind: 'json', schema: CreateInviteBody },
        responses: { 201: { kind: 'json', schema: CreateInviteResult } },
        stepUp: true,
    }),
    revokeInvite: defineRoute({
        id: 'revokeInvite',
        method: 'DELETE',
        path: '/invites/{inviteId}',
        summary: 'Revoke a pending invite',
        permission: 'members.manage',
        params: InviteParams,
        responses: { 204: { kind: 'empty' } },
    }),
} as const;
