import { z } from 'zod';

import { DEFAULT_PAGE_LIMIT, MAX_CURSOR_LENGTH, MAX_PAGE_LIMIT, MAX_USER_AGENT_LENGTH } from './constants';
import { Permission } from './permissions';
import { ProblemCode } from './problem-codes';

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * IDs the engine derives from names: a chat is its normalized `CHAT` name and a message `<chat>#<position>`. Clients
 * treat them as opaque; they are printable text without control or format characters (which could reorder what the
 * UI shows) and without surrounding whitespace. A superset of `OPAQUE_ID_PATTERN`.
 */
const ENGINE_REF_PATTERN = /^(?=\S)[^\p{C}]{1,512}(?<=\S)$/u;

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
export const ChatId = z.string().regex(ENGINE_REF_PATTERN).brand<'ChatId', 'inout'>();
export type ChatId = z.infer<typeof ChatId>;
export const MessageId = z.string().regex(ENGINE_REF_PATTERN).brand<'MessageId', 'inout'>();
export type MessageId = z.infer<typeof MessageId>;
export const MemberId = z.string().regex(OPAQUE_ID_PATTERN).brand<'MemberId', 'inout'>();
export type MemberId = z.infer<typeof MemberId>;
export const InviteId = z.string().regex(OPAQUE_ID_PATTERN).brand<'InviteId', 'inout'>();
export type InviteId = z.infer<typeof InviteId>;
export const AccessRequestId = z.string().regex(OPAQUE_ID_PATTERN).brand<'AccessRequestId', 'inout'>();
export type AccessRequestId = z.infer<typeof AccessRequestId>;
/** The dashboard's ID for a user, carried by an access ticket; opaque to the engine. */
export const DashboardUserId = z.string().regex(OPAQUE_ID_PATTERN).brand<'DashboardUserId', 'inout'>();
export type DashboardUserId = z.infer<typeof DashboardUserId>;
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
export const RunId = z.string().regex(OPAQUE_ID_PATTERN).brand<'RunId', 'inout'>();
export type RunId = z.infer<typeof RunId>;
export const ToolCallId = z.string().regex(OPAQUE_ID_PATTERN).brand<'ToolCallId', 'inout'>();
export type ToolCallId = z.infer<typeof ToolCallId>;
export const TriggerId = z.string().regex(OPAQUE_ID_PATTERN).brand<'TriggerId', 'inout'>();
export type TriggerId = z.infer<typeof TriggerId>;
/** The engine's transport form of a task's identity (its normalized Book name, or an engine-owned definition). */
export const TaskId = z.string().regex(OPAQUE_ID_PATTERN).brand<'TaskId', 'inout'>();
export type TaskId = z.infer<typeof TaskId>;
export const TaskOccurrenceId = z.string().regex(OPAQUE_ID_PATTERN).brand<'TaskOccurrenceId', 'inout'>();
export type TaskOccurrenceId = z.infer<typeof TaskOccurrenceId>;
export const TriggerFireId = z.string().regex(OPAQUE_ID_PATTERN).brand<'TriggerFireId', 'inout'>();
export type TriggerFireId = z.infer<typeof TriggerFireId>;
export const IntegrationId = z.string().regex(OPAQUE_ID_PATTERN).brand<'IntegrationId', 'inout'>();
export type IntegrationId = z.infer<typeof IntegrationId>;
export const ActivityId = z.string().regex(OPAQUE_ID_PATTERN).brand<'ActivityId', 'inout'>();
export type ActivityId = z.infer<typeof ActivityId>;
export const FileVersionId = z.string().regex(OPAQUE_ID_PATTERN).brand<'FileVersionId', 'inout'>();
export type FileVersionId = z.infer<typeof FileVersionId>;
export const LiveSessionId = z.string().regex(OPAQUE_ID_PATTERN).brand<'LiveSessionId', 'inout'>();
export type LiveSessionId = z.infer<typeof LiveSessionId>;
/** An AI tool's stable name on the engine, e.g. `claude-code`; the same on every engine for the same tool. */
export const AiToolId = z.string().regex(OPAQUE_ID_PATTERN).brand<'AiToolId', 'inout'>();
export type AiToolId = z.infer<typeof AiToolId>;
export const AiToolSignInId = z.string().regex(OPAQUE_ID_PATTERN).brand<'AiToolSignInId', 'inout'>();
export type AiToolSignInId = z.infer<typeof AiToolSignInId>;

/** An ID of any kind, for fields whose kind is given by another field (audit targets); chat IDs included. */
export const OpaqueId = z.string().regex(ENGINE_REF_PATTERN);

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

/**
 * The engine's ID: SHA-256 of its public key, base32 lowercase, 26 characters. Same rule as `@ptbk/protocol`, defined
 * independently; it is the first label of the default hostname, and the UI derives the engine fingerprint from it.
 */
export const EngineId = z
    .string()
    .regex(/^[a-z2-7]{26}$/)
    .brand<'EngineId'>();
export type EngineId = z.infer<typeof EngineId>;

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

/** A short, stable machine name (error codes, provider names). */
export const Slug = z
    .string()
    .max(64)
    .regex(/^[a-z][a-z0-9-]*$/);

/** Query strings carry numbers as text, so `limit` is coerced; typed callers still pass a number. */
export const PageQuery = z.strictObject({
    cursor: Cursor.optional(),
    limit: z.coerce.number<number>().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});
export type PageQuery = z.output<typeof PageQuery>;

/** One value or a comma-separated set of them, e.g. `infected,failed`; read as the set's values. */
export function valueSet<const Values extends readonly [string, ...string[]]>(values: Values) {
    const alternatives = values.join('|');
    return z
        .string()
        .max(128)
        .regex(new RegExp(`^(?:${alternatives})(?:,(?:${alternatives}))*$`))
        .transform((value) => [...new Set(value.split(','))])
        .pipe(z.array(z.enum(values)));
}

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
 * `errors` with `validation-failed` and `invalid-schedule`, `requiredPermission` with `forbidden`, `diagnostics` with `invalid-book`,
 * `attemptsRemaining` with `access-code-mismatch`, `aiToolId` with `ai-tool-sign-in-required`.
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
    /** Wrong codes the access request still survives, 0 once this one deleted it. Older engines omit it. */
    attemptsRemaining: z.int().min(0).max(1000).optional(),
    /** With `ai-tool-sign-in-required`: the AI tool to sign in again (`ai-tools@1`). */
    aiToolId: AiToolId.optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

/** Where an authenticated request came from: the IP from the tunnel's OPEN frame and the request's `User-Agent`. */
export const ClientInfo = z.strictObject({
    ip: z.union([z.ipv4(), z.ipv6()]),
    userAgent: z.string().max(MAX_USER_AGENT_LENGTH),
});
export type ClientInfo = z.infer<typeof ClientInfo>;
