import { z } from 'zod';

import { ClientInfo, MemberId, PageQuery, SessionId, Timestamp, pageOf } from './common';
import { defineRoute } from './route';

export const Session = z.strictObject({
    id: SessionId,
    memberId: MemberId,
    /** Whether this is the session making the request. */
    current: z.boolean(),
    client: ClientInfo.nullable(),
    createdAt: Timestamp,
    lastSeenAt: Timestamp,
    expiresAt: Timestamp,
});
export type Session = z.infer<typeof Session>;
export const SessionPage = pageOf(Session);

export const SessionListQuery = PageQuery.extend({ memberId: MemberId.optional() });
export const SessionParams = z.strictObject({ sessionId: SessionId });

export const SESSION_ROUTES = {
    listSessions: defineRoute({
        id: 'listSessions',
        method: 'GET',
        path: '/sessions',
        summary: 'List active sessions, most recently seen first',
        permission: 'security.read',
        query: SessionListQuery,
        responses: { 200: { kind: 'json', schema: SessionPage } },
    }),
    revokeSession: defineRoute({
        id: 'revokeSession',
        method: 'DELETE',
        path: '/sessions/{sessionId}',
        summary: 'Revoke a session; it fails from the next request on',
        permission: 'members.manage',
        params: SessionParams,
        responses: { 204: { kind: 'empty' } },
    }),
} as const;
