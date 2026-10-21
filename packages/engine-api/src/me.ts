import { z } from 'zod';

import { MemberId, OrgId, PageQuery } from './common';
import { PASSKEY_PAGE_RESPONSE, PasskeyParams } from './passkeys';
import { Permission, Role } from './permissions';
import { defineRoute } from './route';
import { SessionPage, SessionParams } from './sessions';

/** The signed-in member. The UI renders by `permissions`, never by `role`. */
export const Me = z.strictObject({
    memberId: MemberId,
    orgId: OrgId,
    displayName: z.string().min(1).max(256),
    role: Role,
    permissions: z.array(Permission),
});
export type Me = z.infer<typeof Me>;

export const RevokeOtherSessionsResult = z.strictObject({ revoked: z.int().min(0) });

const OWN_CREDENTIAL =
    "Needs no permission, but the engine checks that the credential belongs to the caller: another member's ID and an " +
    'unknown ID both get 404 `not-found`, never 403, so IDs cannot be probed.';

/**
 * Self-service under `/me`: every member manages their own passkeys and sessions without `members.manage`.
 * `/passkeys` and `/sessions` stay the admin view over everyone's.
 */
export const ME_ROUTES = {
    getMe: defineRoute({
        id: 'getMe',
        method: 'GET',
        path: '/me',
        summary: 'Get the signed-in member and their permissions',
        permission: null,
        responses: { 200: { kind: 'json', schema: Me } },
    }),
    listMyPasskeys: defineRoute({
        id: 'listMyPasskeys',
        method: 'GET',
        path: '/me/passkeys',
        summary: "List the caller's own passkeys, newest first",
        permission: null,
        query: PageQuery,
        responses: PASSKEY_PAGE_RESPONSE,
    }),
    revokeMyPasskey: defineRoute({
        id: 'revokeMyPasskey',
        method: 'DELETE',
        path: '/me/passkeys/{passkeyId}',
        summary: "Revoke one of the caller's own passkeys; never the last one",
        description: `${OWN_CREDENTIAL} The caller's last passkey is refused with 409 \`last-passkey\`, so nobody locks themselves out; an owner who lost every device recovers through the engine reset.`,
        permission: null,
        params: PasskeyParams,
        responses: { 204: { kind: 'empty' } },
        problems: ['last-passkey'],
        stepUp: true,
    }),
    listMySessions: defineRoute({
        id: 'listMySessions',
        method: 'GET',
        path: '/me/sessions',
        summary: "List the caller's own active sessions, most recently seen first",
        permission: null,
        query: PageQuery,
        responses: { 200: { kind: 'json', schema: SessionPage } },
    }),
    revokeMySession: defineRoute({
        id: 'revokeMySession',
        method: 'DELETE',
        path: '/me/sessions/{sessionId}',
        summary: "Revoke one of the caller's own sessions",
        description: OWN_CREDENTIAL,
        permission: null,
        params: SessionParams,
        responses: { 204: { kind: 'empty' } },
    }),
    revokeMyOtherSessions: defineRoute({
        id: 'revokeMyOtherSessions',
        method: 'POST',
        path: '/me/sessions/revoke-others',
        summary: 'Sign out everywhere else: revoke every session of the caller except the current one',
        description: "Answers with how many sessions were revoked. Other members' sessions are never touched.",
        permission: null,
        responses: { 200: { kind: 'json', schema: RevokeOtherSessionsResult } },
    }),
} as const;
