import { z } from 'zod';

import { Cursor, MemberId, PageQuery, PasskeyId, Timestamp, pageOf } from './common';
import { defineRoute } from './route';
import { openEnum, toTolerant } from './tolerant';

/** WebAuthn `authenticatorAttachment`: built into the device, or a roaming key (security key, phone). */
export const AUTHENTICATOR_ATTACHMENTS = ['platform', 'cross-platform'] as const;

const authenticatorShape = {
    /** As the browser reported it at registration; `null` when it did not. */
    attachment: z.enum(AUTHENTICATOR_ATTACHMENTS).nullable(),
    /** The WebAuthn backup state (BS flag) at the last assertion: a synced passkey; `null` when unknown. */
    backedUp: z.boolean().nullable(),
};

const passkeyShape = {
    id: PasskeyId,
    memberId: MemberId,
    name: z.string().max(128),
    createdAt: Timestamp,
    lastUsedAt: Timestamp.nullable(),
    /** What kind of authenticator holds it; `null` from engines on API 1.2. */
    authenticator: z.strictObject(authenticatorShape).nullable().default(null),
};

/**
 * Registering a passkey is the gateway's job; this API only lists and revokes. Revoking one also ends every session it
 * signed in (`Session.passkeyId`).
 */
export const Passkey = z.strictObject(passkeyShape);
export type Passkey = z.infer<typeof Passkey>;
export const PasskeyPage = pageOf(Passkey);

/** A passkey as the client reads it: an attachment this contract does not know yet reads as `unknown`. */
export const PasskeyReader = toTolerant(
    z.strictObject({
        ...passkeyShape,
        authenticator: z
            .strictObject({ ...authenticatorShape, attachment: openEnum(AUTHENTICATOR_ATTACHMENTS).nullable() })
            .nullable()
            .default(null),
    }),
);
export type ReadPasskey = z.output<typeof PasskeyReader>;
export const PasskeyPageReader = z.object({ items: z.array(PasskeyReader), nextCursor: Cursor.nullable() });
/** Both passkey lists, `/me/passkeys` and `/passkeys`. */
export const PASSKEY_PAGE_RESPONSE = {
    200: { kind: 'json', schema: PasskeyPage, read: PasskeyPageReader },
} as const;

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
        responses: PASSKEY_PAGE_RESPONSE,
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
