import { z } from 'zod';

import { DEFAULT_PAGE_LIMIT, MAX_CURSOR_LENGTH, MAX_PAGE_LIMIT, MAX_USER_AGENT_LENGTH } from './constants';
import { Permission } from './permissions';
import { ProblemCode } from './problem-codes';

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// IDs are branded on input too, so a caller cannot pass an agent ID where a chat ID is expected. Each needs its own
// schema instance (`brand` returns the same one), because OpenAPI names components by instance.
export const OrgId = z.string().regex(OPAQUE_ID_PATTERN).brand<'OrgId', 'inout'>();
export type OrgId = z.infer<typeof OrgId>;
export const AgentId = z.string().regex(OPAQUE_ID_PATTERN).brand<'AgentId', 'inout'>();
export type AgentId = z.infer<typeof AgentId>;
/** Stable across renames; used in public URLs. */
export const AgentPermanentId = z.string().regex(OPAQUE_ID_PATTERN).brand<'AgentPermanentId', 'inout'>();
export type AgentPermanentId = z.infer<typeof AgentPermanentId>;
export const FolderId = z.string().regex(OPAQUE_ID_PATTERN).brand<'FolderId', 'inout'>();
export type FolderId = z.infer<typeof FolderId>;
export const RevisionId = z.string().regex(OPAQUE_ID_PATTERN).brand<'RevisionId', 'inout'>();
export type RevisionId = z.infer<typeof RevisionId>;
export const ChatId = z.string().regex(OPAQUE_ID_PATTERN).brand<'ChatId', 'inout'>();
export type ChatId = z.infer<typeof ChatId>;
export const MessageId = z.string().regex(OPAQUE_ID_PATTERN).brand<'MessageId', 'inout'>();
export type MessageId = z.infer<typeof MessageId>;
export const MemberId = z.string().regex(OPAQUE_ID_PATTERN).brand<'MemberId', 'inout'>();
export type MemberId = z.infer<typeof MemberId>;
export const InviteId = z.string().regex(OPAQUE_ID_PATTERN).brand<'InviteId', 'inout'>();
export type InviteId = z.infer<typeof InviteId>;
export const ApiTokenId = z.string().regex(OPAQUE_ID_PATTERN).brand<'ApiTokenId', 'inout'>();
export type ApiTokenId = z.infer<typeof ApiTokenId>;
export const SecretId = z.string().regex(OPAQUE_ID_PATTERN).brand<'SecretId', 'inout'>();
export type SecretId = z.infer<typeof SecretId>;
export const FileId = z.string().regex(OPAQUE_ID_PATTERN).brand<'FileId', 'inout'>();
export type FileId = z.infer<typeof FileId>;
export const AuditEntryId = z.string().regex(OPAQUE_ID_PATTERN).brand<'AuditEntryId', 'inout'>();
export type AuditEntryId = z.infer<typeof AuditEntryId>;
export const PasskeyId = z.string().regex(OPAQUE_ID_PATTERN).brand<'PasskeyId', 'inout'>();
export type PasskeyId = z.infer<typeof PasskeyId>;
export const SessionId = z.string().regex(OPAQUE_ID_PATTERN).brand<'SessionId', 'inout'>();
export type SessionId = z.infer<typeof SessionId>;

/** An ID of any kind, for fields whose kind is given by another field (audit targets). */
export const OpaqueId = z.string().regex(OPAQUE_ID_PATTERN);

/** RFC 3339 in UTC (`Z`), any sub-second precision. Same rule as `@ptbk/protocol`, defined independently. */
export const Timestamp = z.iso.datetime().brand<'Timestamp'>();
export type Timestamp = z.infer<typeof Timestamp>;

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';

/**
 * ASCII hostname (IDN as A-labels), lowercased, at least two labels, no trailing dot. An all-digit last label is
 * refused, which rules out IPv4 literals; IPv6 literals fail on `:` and brackets.
 */
export const Hostname = z
    .string()
    .max(253)
    .toLowerCase()
    .regex(new RegExp(`^(?:${LABEL}\\.)+(?![0-9]+$)${LABEL}$`))
    .brand<'Hostname'>();
export type Hostname = z.infer<typeof Hostname>;

/** Strict SemVer 2.0 (the regex from semver.org). */
export const SemVer = z
    .string()
    .max(256)
    .regex(
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
    )
    .brand<'SemVer'>();
export type SemVer = z.infer<typeof SemVer>;

export const Sha256Hex = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .brand<'Sha256Hex'>();
export type Sha256Hex = z.infer<typeof Sha256Hex>;

export const Cursor = z.string().min(1).max(MAX_CURSOR_LENGTH);

/** Query strings carry numbers as text, so `limit` is coerced; typed callers still pass a number. */
export const PageQuery = z.strictObject({
    cursor: Cursor.optional(),
    limit: z.coerce.number<number>().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});
export type PageQuery = z.output<typeof PageQuery>;

export function pageOf<Item extends z.ZodType>(item: Item) {
    return z.strictObject({ items: z.array(item), nextCursor: Cursor.nullable() });
}
export interface Page<T> {
    readonly items: readonly T[];
    readonly nextCursor: string | null;
}

export const DIAGNOSTIC_SEVERITIES = ['error', 'warning', 'info'] as const;
export const Diagnostic = z.strictObject({
    severity: z.enum(DIAGNOSTIC_SEVERITIES),
    code: z.string().min(1).max(64),
    message: z.string().max(4096),
    /** 1-based, end inclusive. */
    range: z.strictObject({
        startLine: z.int().min(1),
        startColumn: z.int().min(1),
        endLine: z.int().min(1),
        endColumn: z.int().min(1),
    }),
});
export type Diagnostic = z.infer<typeof Diagnostic>;

/**
 * RFC 9457 problem details. Extensions are declared like any other field, because the schema is strict:
 * `errors` with `validation-failed`, `requiredPermission` with `forbidden`, `diagnostics` with `invalid-book`.
 */
export const ProblemDetails = z.strictObject({
    type: z.string().min(1).max(2048),
    title: z.string().min(1).max(256),
    status: z.int().min(400).max(599),
    detail: z.string().max(4096).optional(),
    instance: z.string().max(2048).optional(),
    code: ProblemCode,
    errors: z.array(z.strictObject({ path: z.string().max(1024), message: z.string().max(1024) })).optional(),
    requiredPermission: Permission.optional(),
    diagnostics: z.array(Diagnostic).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

/** Where an authenticated request came from: the IP from the tunnel's OPEN frame and the request's `User-Agent`. */
export const ClientInfo = z.strictObject({
    ip: z.union([z.ipv4(), z.ipv6()]),
    userAgent: z.string().max(MAX_USER_AGENT_LENGTH),
});
export type ClientInfo = z.infer<typeof ClientInfo>;
