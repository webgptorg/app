import { z } from 'zod';

import {
    ApiTokenId,
    AuditEntryId,
    ClientInfo,
    MemberId,
    OpaqueId,
    PageQuery,
    Sha256Hex,
    Timestamp,
    pageOf,
} from './common';
import { defineRoute } from './route';

/** Closed: a new action is an additive contract change, so the UI can label and filter every one. */
export const AUDIT_ACTIONS = [
    'auth.sign-in',
    'auth.sign-out',
    'auth.step-up',
    'passkey.register',
    'passkey.revoke',
    'session.revoke',
    'agent.create',
    'agent.update',
    'agent.delete',
    'agent.restore',
    'agent.source.update',
    'agent.start',
    'agent.stop',
    'folder.create',
    'folder.rename',
    'folder.delete',
    'chat.create',
    'chat.message.send',
    'chat.reply.cancel',
    'member.update',
    'member.remove',
    'invite.create',
    'invite.revoke',
    'api-token.create',
    'api-token.revoke',
    'settings.update',
    'settings.update-policy',
    'secret.create',
    'secret.replace',
    'secret.revoke',
    'secret.delete',
    'file.upload',
    'file.delete',
    'engine.update.install',
    'ui.update.install',
] as const;
export const AuditAction = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof AuditAction>;

export const AUDIT_TARGET_KINDS = [
    'agent',
    'folder',
    'chat',
    'message',
    'member',
    'invite',
    'api-token',
    'secret',
    'file',
    'passkey',
    'session',
    'settings',
    'engine',
] as const;
export const AuditTargetKind = z.enum(AUDIT_TARGET_KINDS);

export const AUDIT_OUTCOMES = ['success', 'denied', 'failed'] as const;
export const AuditOutcome = z.enum(AUDIT_OUTCOMES);

export const AuditActor = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('member'), memberId: MemberId }),
    z.strictObject({ kind: z.literal('api-token'), apiTokenId: ApiTokenId, memberId: MemberId }),
    z.strictObject({ kind: z.literal('system') }),
]);
export type AuditActor = z.infer<typeof AuditActor>;

/**
 * One link of the append-only, hash-chained log. `prevHash` is `null` only for the first entry. How `hash` is computed
 * is the engine's business; `GET /audit/verify` re-walks the chain.
 */
export const AuditEntry = z.strictObject({
    id: AuditEntryId,
    seq: z.int().min(1),
    at: Timestamp,
    actor: AuditActor,
    action: AuditAction,
    target: z.strictObject({ kind: AuditTargetKind, id: OpaqueId }).nullable(),
    outcome: AuditOutcome,
    /** `null` for system actions. */
    client: ClientInfo.nullable(),
    hash: Sha256Hex,
    prevHash: Sha256Hex.nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;
export const AuditPage = pageOf(AuditEntry);

export const AuditListQuery = PageQuery.extend({
    memberId: MemberId.optional(),
    action: AuditAction.optional(),
    targetKind: AuditTargetKind.optional(),
    targetId: OpaqueId.optional(),
    outcome: AuditOutcome.optional(),
    /** Inclusive. */
    from: Timestamp.optional(),
    /** Exclusive. */
    to: Timestamp.optional(),
});

export const AuditVerification = z.strictObject({
    status: z.enum(['intact', 'broken']),
    checkedEntries: z.int().min(0),
    lastSeq: z.int().min(1).nullable(),
    firstBrokenSeq: z.int().min(1).nullable(),
    checkedAt: Timestamp,
});
export type AuditVerification = z.infer<typeof AuditVerification>;

export const AUDIT_ROUTES = {
    listAuditEntries: defineRoute({
        id: 'listAuditEntries',
        method: 'GET',
        path: '/audit',
        summary: 'List audit entries, newest first',
        permission: 'audit.read',
        query: AuditListQuery,
        responses: { 200: { kind: 'json', schema: AuditPage } },
    }),
    verifyAuditLog: defineRoute({
        id: 'verifyAuditLog',
        method: 'GET',
        path: '/audit/verify',
        summary: 'Re-walk the whole hash chain, so the owner can confirm nothing was removed or edited',
        permission: 'audit.read',
        responses: { 200: { kind: 'json', schema: AuditVerification } },
    }),
} as const;
