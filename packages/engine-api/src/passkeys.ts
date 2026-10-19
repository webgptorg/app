import { z } from 'zod';

import { MemberId, PageQuery, PasskeyId, Timestamp, pageOf } from './common';
import { defineRoute } from './route';

/** Registering a passkey is the gateway's job; this API only lists and revokes. */
export const Passkey = z.strictObject({
    id: PasskeyId,
    memberId: MemberId,
    name: z.string().max(128),
    createdAt: Timestamp,
    lastUsedAt: Timestamp.nullable(),
});
export type Passkey = z.infer<typeof Passkey>;
export const PasskeyPage = pageOf(Passkey);

export const PasskeyListQuery = PageQuery.extend({ memberId: MemberId.optional() });
export const PasskeyParams = z.strictObject({ passkeyId: PasskeyId });

export const PASSKEY_ROUTES = {
    listPasskeys: defineRoute({
        id: 'listPasskeys',
        method: 'GET',
        path: '/passkeys',
        summary: 'List passkeys, newest first',
        permission: 'security.read',
        query: PasskeyListQuery,
        responses: { 200: { kind: 'json', schema: PasskeyPage } },
    }),
    revokePasskey: defineRoute({
        id: 'revokePasskey',
        method: 'DELETE',
        path: '/passkeys/{passkeyId}',
        summary: "Revoke a passkey; a member's last passkey cannot be revoked",
        permission: 'members.manage',
        params: PasskeyParams,
        responses: { 204: { kind: 'empty' } },
        problems: ['last-passkey'],
        stepUp: true,
    }),
} as const;
