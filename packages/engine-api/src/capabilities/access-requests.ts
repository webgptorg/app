import { z } from 'zod';

import { AccessRequestId, PageQuery, Timestamp, pageOf } from '../common';
import { Member } from '../members';
import { Role } from '../permissions';
import { defineRoute } from '../route';
import { KNOWN_CAPABILITIES } from './capability';

/** An engine keeps at most this many pending requests; the gateway refuses further tickets until some are handled. */
export const MAX_PENDING_ACCESS_REQUESTS = 20;
/** A request nobody handled is dropped after this long. */
export const ACCESS_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ACCESS_CODE_PATTERN = /^\d{6}$/;
/**
 * Wrong codes a request survives: the one that reaches this deletes it, and the person needs a new ticket. Six digits
 * then leave a guesser 5 in a million, and an approver who mistypes a few times can still finish.
 */
export const MAX_ACCESS_CODE_ATTEMPTS = 5;

/** The roles a dashboard ticket may propose; the approver may grant any role. */
export const PROPOSED_ROLES = ['admin', 'member'] as const;

/**
 * Someone the organization invited, waiting for an engine admin. `displayName` and `email` come from the dashboard's
 * ticket: untrusted hints, shown as "as reported by your organization". The 6-digit code is never returned; the person
 * reads it from their own screen to whoever approves.
 */
export const AccessRequest = z.strictObject({
    id: AccessRequestId,
    displayName: z.string().min(1).max(128),
    email: z.string().min(3).max(254),
    proposedRole: z.enum(PROPOSED_ROLES),
    createdAt: Timestamp,
    expiresAt: Timestamp,
});
export type AccessRequest = z.infer<typeof AccessRequest>;
export const AccessRequestPage = pageOf(AccessRequest);

export const AccessRequestParams = z.strictObject({ accessRequestId: AccessRequestId });
export const ApproveAccessRequestBody = z.strictObject({ code: z.string().regex(ACCESS_CODE_PATTERN), role: Role });
export const DashboardRemovals = z.strictObject({ enabled: z.boolean() });
export type DashboardRemovals = z.infer<typeof DashboardRemovals>;

const capability = KNOWN_CAPABILITIES.accessRequests;

export const ACCESS_REQUEST_ROUTES = {
    listAccessRequests: defineRoute({
        id: 'listAccessRequests',
        method: 'GET',
        path: '/access-requests',
        summary: 'List pending access requests, oldest first',
        permission: 'members.read',
        capability,
        query: PageQuery,
        responses: { 200: { kind: 'json', schema: AccessRequestPage } },
    }),
    approveAccessRequest: defineRoute({
        id: 'approveAccessRequest',
        method: 'POST',
        path: '/access-requests/{accessRequestId}/approve',
        summary: 'Approve an access request with the code the person reads out; they become a member',
        description:
            'The member gets the role in the body, the passkey registered with the request and the ticket’s ' +
            '`dashboardUserId`. A wrong code is 422 `access-code-mismatch` and leaves the request pending, except ' +
            'the fifth wrong code for a request, which also deletes it.',
        permission: 'members.manage',
        capability,
        params: AccessRequestParams,
        body: { kind: 'json', schema: ApproveAccessRequestBody },
        responses: { 201: { kind: 'json', schema: Member } },
        problems: ['access-code-mismatch'],
        stepUp: true,
    }),
    declineAccessRequest: defineRoute({
        id: 'declineAccessRequest',
        method: 'DELETE',
        path: '/access-requests/{accessRequestId}',
        summary: 'Decline an access request; its passkey is discarded',
        permission: 'members.manage',
        capability,
        params: AccessRequestParams,
        responses: { 204: { kind: 'empty' } },
    }),
    setDashboardRemovals: defineRoute({
        id: 'setDashboardRemovals',
        method: 'PUT',
        path: '/settings/dashboard-removals',
        summary: 'Allow or refuse member removals signed by the dashboard',
        permission: 'settings.manage',
        capability,
        body: { kind: 'json', schema: DashboardRemovals },
        responses: { 200: { kind: 'json', schema: DashboardRemovals } },
        stepUp: true,
    }),
} as const;
