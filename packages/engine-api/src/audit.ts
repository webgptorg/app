import { z } from 'zod';

import {
    ApiTokenId,
    AuditEntryId,
    ClientInfo,
    Cursor,
    MemberId,
    OpaqueId,
    PageQuery,
    Sha256Hex,
    Timestamp,
    pageOf,
} from './common';
import { MAX_AUDIT_DETAILS_BYTES, MAX_AUDIT_DETAILS_DEPTH, MAX_AUDIT_TARGET_NAME_LENGTH } from './constants';
import { KNOWN_CAPABILITIES } from './capabilities/capability';
import { defineRoute } from './route';
import { toTolerant } from './tolerant';

/** Closed: a new action is an additive contract change, so the UI can label and filter every one. */
export const AUDIT_ACTIONS = [
    'auth.sign-in',
    'auth.sign-out',
    'auth.step-up',
    'passkey.register',
    'passkey.revoke',
    'session.revoke',
    'session.revoke-others',
    'agent.create',
    'agent.update',
    'agent.delete',
    'agent.restore',
    'agent.source.update',
    'agent.start',
    'agent.stop',
    'agent.test-chat.start',
    'folder.create',
    'folder.rename',
    'folder.delete',
    'chat.create',
    'chat.message.send',
    'chat.reply.cancel',
    'chat.reply.retry',
    'member.update',
    'member.remove',
    'invite.create',
    'invite.revoke',
    'access-request.approve',
    'access-request.decline',
    'member.revoke',
    'api-token.create',
    'api-token.revoke',
    'settings.update',
    'settings.update-policy',
    'settings.dashboard-removals',
    /** `updates@1`: a member ran the UI update check early; the check's own outcome is in `GET /security`. */
    'updates.ui-check',
    'wallet.record.save',
    'wallet.record.update',
    'wallet.record.delete',
    'wallet.request.seen',
    'wallet.request.reject',
    'file.upload',
    'file.delete',
    'run.cancel',
    'run.retry',
    'trigger.create',
    'trigger.update',
    'trigger.pause',
    'trigger.resume',
    'trigger.delete',
    'integration.create',
    'integration.update',
    'integration.enable',
    'integration.disable',
    'integration.delete',
    'browser.sign-in.open',
    'browser.watch',
    'browser.control.take',
    'browser.control.hand-back',
    'browser.session.end',
    'browser.channel.attach',
    'browser.help.dismiss',
    'ai-tool.sign-in.start',
    'ai-tool.sign-in.complete',
    'ai-tool.sign-out',
    'engine.update.install',
    'ui.update.install',
] as const;
export const AuditAction = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof AuditAction>;

/** The shape every action, known or a newer engine's, has: dotted kebab-case segments. */
export const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/** An action as the client reads it: one of `AUDIT_ACTIONS`, or a newer engine's kept as its raw name for display. */
export type ReadAuditAction = AuditAction | (string & Record<never, never>);

const KNOWN_AUDIT_ACTIONS: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

export function isAuditAction(value: string): value is AuditAction {
    return KNOWN_AUDIT_ACTIONS.has(value);
}

export const AUDIT_TARGET_KINDS = [
    'agent',
    'folder',
    'chat',
    'message',
    'member',
    'invite',
    'access-request',
    'api-token',
    'wallet-record',
    'wallet-request',
    'file',
    'passkey',
    'session',
    'settings',
    'engine',
    'run',
    'trigger',
    'integration',
    'browser-session',
    'browser-help-request',
    'ai-tool',
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
 * Depth is measured without recursion, so a hostile, deeply nested value is refused before anything walks it
 * recursively. Anything `JSON.stringify` cannot serialise is refused too.
 */
function withinAuditDetailsLimits(value: unknown): boolean {
    const pending: { readonly value: unknown; readonly depth: number }[] = [{ value, depth: 1 }];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        if (typeof next.value !== 'object' || next.value === null) continue;
        if (next.depth > MAX_AUDIT_DETAILS_DEPTH) return false;
        for (const child of Object.values(next.value)) pending.push({ value: child, depth: next.depth + 1 });
    }
    // `JSON.stringify` returns `undefined`, despite its type, for a value with no JSON form.
    let serialised: unknown;
    try {
        serialised = JSON.stringify(value);
    } catch {
        return false;
    }
    return typeof serialised === 'string' && new TextEncoder().encode(serialised).byteLength <= MAX_AUDIT_DETAILS_BYTES;
}

/** Any JSON value inside an entry's `details`. */
export const AuditDetailsValue = z.json();

/**
 * What the engine adds about an action, as a JSON object; never secret values, tokens or message content.
 * At most `MAX_AUDIT_DETAILS_BYTES` serialised and `MAX_AUDIT_DETAILS_DEPTH` deep. Untrusted text for the UI.
 */
export const AuditDetails = z
    .unknown()
    .refine(withinAuditDetailsLimits, {
        message: `at most ${String(MAX_AUDIT_DETAILS_BYTES)} bytes as JSON and ${String(MAX_AUDIT_DETAILS_DEPTH)} levels deep`,
    })
    .pipe(z.record(z.string(), AuditDetailsValue));
export type AuditDetails = z.infer<typeof AuditDetails>;

export const AuditTarget = z.strictObject({
    kind: AuditTargetKind,
    id: OpaqueId,
    /**
     * The target's name as it was when the action happened (since API 1.4), so the log still reads after a rename or
     * delete. `null` when the target has no name; absent from older engines. Untrusted text: may be anything a member
     * typed, so the UI shows it as text only.
     */
    name: z.string().max(MAX_AUDIT_TARGET_NAME_LENGTH).nullable().optional(),
});
export type AuditTarget = z.infer<typeof AuditTarget>;

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
    target: AuditTarget.nullable(),
    outcome: AuditOutcome,
    /** `null` for system actions. */
    client: ClientInfo.nullable(),
    /** Since API 1.4; `null` when the engine has nothing to add, absent from older engines. Covered by `hash`. */
    details: AuditDetails.nullable().optional(),
    hash: Sha256Hex,
    prevHash: Sha256Hex.nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;
export const AuditPage = pageOf(AuditEntry);

/**
 * An entry as the client reads it: an `action` this contract does not know yet keeps its raw name instead of failing
 * the page, so the log stays readable after an engine update. The engine's schema stays closed.
 */
export const AuditEntryReader = toTolerant(
    AuditEntry.extend({
        action: z
            .string()
            .max(64)
            .regex(AUDIT_ACTION_PATTERN)
            .transform((action): ReadAuditAction => action),
    }),
);
export type ReadAuditEntry = z.output<typeof AuditEntryReader>;
export const AuditPageReader = z.object({ items: z.array(AuditEntryReader), nextCursor: Cursor.nullable() });

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
        capability: KNOWN_CAPABILITIES.audit,
        query: AuditListQuery,
        responses: { 200: { kind: 'json', schema: AuditPage, read: AuditPageReader } },
    }),
    verifyAuditLog: defineRoute({
        id: 'verifyAuditLog',
        method: 'GET',
        path: '/audit/verify',
        summary: 'Re-walk the whole hash chain, so the owner can confirm nothing was removed or edited',
        permission: 'audit.read',
        capability: KNOWN_CAPABILITIES.audit,
        responses: { 200: { kind: 'json', schema: AuditVerification } },
    }),
} as const;
