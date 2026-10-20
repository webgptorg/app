import { z } from 'zod';

import { AgentId, Cursor, IntegrationId, MemberId, PageQuery, SecretId, Slug, Timestamp, pageOf } from '../common';
import { defineRoute } from '../route';
import { SecretName } from '../secrets';
import { toTolerant } from '../tolerant';
import { KNOWN_CAPABILITIES } from './capability';

/**
 * Open set: engines add kinds within `integrations@1`, and a client that does not know one reads it as
 * `{ kind: 'unknown', rawKind }` without `config` (see `IntegrationReader`).
 */
export const INTEGRATION_KINDS = ['mcp-server', 'calendar', 'repository'] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];
export const IntegrationKindName = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

export const INTEGRATION_STATUSES = ['connected', 'needs-attention', 'disconnected', 'error'] as const;
export const IntegrationStatus = z.enum(INTEGRATION_STATUSES);
export type IntegrationStatus = z.infer<typeof IntegrationStatus>;

export const SECRET_REF_STATES = ['resolved', 'missing', 'revoked'] as const;

/** A secret the integration needs, by name. The value stays in the engine's wallet; `secretId` is `null` while missing. */
export const SecretRef = z.strictObject({
    name: SecretName,
    secretId: SecretId.nullable(),
    state: z.enum(SECRET_REF_STATES),
});
export type SecretRef = z.infer<typeof SecretRef>;

export const IntegrationTool = z.strictObject({
    name: z.string().min(1).max(128),
    description: z.string().max(1024).nullable(),
});

/** An `https:` URL. */
export const McpServerUrl = z.url({ protocol: /^https$/ }).max(2048);
/** `owner/name` on GitHub. */
export const RepositoryName = z
    .string()
    .max(201)
    .regex(/^[A-Za-z0-9-]{1,100}\/[A-Za-z0-9._-]{1,100}$/);

const integrationBase = {
    id: IntegrationId,
    /** `null` for an engine-wide integration that every agent may use. */
    agentId: AgentId.nullable(),
    name: z.string().trim().min(1).max(128),
    status: IntegrationStatus,
    /** Why the status is not `connected`, in a short sentence without secrets. */
    statusDetail: z.string().max(1024).nullable(),
    scopes: z.array(z.string().min(1).max(256)).max(100),
    secretRefs: z.array(SecretRef).max(50),
    tools: z.array(IntegrationTool).max(500),
    lastActivityAt: Timestamp.nullable(),
    createdBy: MemberId,
    createdAt: Timestamp,
    updatedAt: Timestamp,
};

export const Integration = z.discriminatedUnion('kind', [
    z.strictObject({
        ...integrationBase,
        kind: z.literal('mcp-server'),
        config: z.strictObject({ url: McpServerUrl }),
    }),
    z.strictObject({
        ...integrationBase,
        kind: z.literal('calendar'),
        config: z.strictObject({ provider: Slug, account: z.string().min(1).max(256) }),
    }),
    z.strictObject({
        ...integrationBase,
        kind: z.literal('repository'),
        config: z.strictObject({ provider: z.literal('github'), repository: RepositoryName }),
    }),
]);
export type Integration = z.infer<typeof Integration>;
export const IntegrationPage = pageOf(Integration);

/** How a client sees an integration of a kind it does not know: everything but the kind-specific `config`. */
export const UnknownKindIntegration = z.strictObject({
    ...integrationBase,
    kind: z.literal('unknown'),
    rawKind: IntegrationKindName,
});
export type UnknownKindIntegration = z.infer<typeof UnknownKindIntegration>;

export type ReadIntegration = Integration | UnknownKindIntegration;

const tolerantIntegration = toTolerant(Integration);
const tolerantUnknownKind = toTolerant(UnknownKindIntegration);

function isKnownKind(kind: string): kind is IntegrationKind {
    return (INTEGRATION_KINDS as readonly string[]).includes(kind);
}

/** The client's reading of one integration: known kinds tolerantly, unknown kinds without their `config`. */
export const IntegrationReader = z.unknown().transform((raw, ctx): ReadIntegration => {
    const record = typeof raw === 'object' && raw !== null ? (raw as Readonly<Record<string, unknown>>) : undefined;
    const rawKind = record?.['kind'];
    let result: z.ZodSafeParseResult<ReadIntegration>;
    if (record && typeof rawKind === 'string' && !isKnownKind(rawKind)) {
        const rest: Record<string, unknown> = { ...record };
        delete rest['config'];
        result = tolerantUnknownKind.safeParse({ ...rest, kind: 'unknown', rawKind });
    } else {
        result = tolerantIntegration.safeParse(raw);
    }
    if (result.success) return result.data;
    for (const issue of result.error.issues) {
        ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    }
    return z.NEVER;
});
export const IntegrationPageReader = z.object({ items: z.array(IntegrationReader), nextCursor: Cursor.nullable() });

export const IntegrationListQuery = PageQuery.extend({
    agentId: AgentId.optional(),
    kind: IntegrationKindName.optional(),
    status: IntegrationStatus.optional(),
});

export const IntegrationParams = z.strictObject({ integrationId: IntegrationId });

const SecretNames = z.array(SecretName).max(50);

/** Calendars connect through the engine's OAuth flow (`connectCalendar`), not here. */
export const CreateIntegrationBody = z.discriminatedUnion('kind', [
    z.strictObject({
        kind: z.literal('mcp-server'),
        name: integrationBase.name,
        agentId: AgentId.nullable().optional(),
        url: McpServerUrl,
        secretNames: SecretNames.optional(),
    }),
    z.strictObject({
        kind: z.literal('repository'),
        name: integrationBase.name,
        agentId: AgentId.nullable().optional(),
        provider: z.literal('github'),
        repository: RepositoryName,
        secretNames: SecretNames.optional(),
    }),
]);

/** `url` applies only to MCP servers. Secrets are referenced by name; their values are managed under `/secrets`. */
export const UpdateIntegrationBody = z.strictObject({
    name: integrationBase.name.optional(),
    url: McpServerUrl.optional(),
    secretNames: SecretNames.optional(),
});

export const ConnectCalendarBody = z.strictObject({ provider: Slug, agentId: AgentId.nullable().optional() });
/** A same-origin engine path the browser navigates to; the engine runs the provider's OAuth flow from there. */
export const ConnectCalendarResult = z.strictObject({
    redirectPath: z
        .string()
        .max(2048)
        .regex(/^\/(?!\/)[\x21-\x7e]*$/),
});

export const IntegrationChangedEvent = z.strictObject({
    type: z.literal('integration.changed'),
    integrationId: IntegrationId,
    agentId: AgentId.nullable(),
});

const capability = KNOWN_CAPABILITIES.integrations;
const one = { kind: 'json', schema: Integration, read: IntegrationReader } as const;

export const INTEGRATION_ROUTES = {
    listIntegrations: defineRoute({
        id: 'listIntegrations',
        method: 'GET',
        path: '/integrations',
        summary: 'List integrations, newest first',
        permission: 'integrations.read',
        capability,
        query: IntegrationListQuery,
        responses: { 200: { kind: 'json', schema: IntegrationPage, read: IntegrationPageReader } },
    }),
    createIntegration: defineRoute({
        id: 'createIntegration',
        method: 'POST',
        path: '/integrations',
        summary: 'Connect an MCP server or a repository',
        permission: 'integrations.manage',
        capability,
        body: { kind: 'json', schema: CreateIntegrationBody },
        responses: { 201: one },
        problems: ['name-taken', 'agent-deleted'],
    }),
    connectCalendar: defineRoute({
        id: 'connectCalendar',
        method: 'POST',
        path: '/integrations/calendar/connect',
        summary: "Start the engine's OAuth flow that connects a calendar",
        permission: 'integrations.manage',
        capability,
        body: { kind: 'json', schema: ConnectCalendarBody },
        responses: { 202: { kind: 'json', schema: ConnectCalendarResult } },
        draft: true,
    }),
    getIntegration: defineRoute({
        id: 'getIntegration',
        method: 'GET',
        path: '/integrations/{integrationId}',
        summary: 'Get an integration',
        permission: 'integrations.read',
        capability,
        params: IntegrationParams,
        responses: { 200: one },
    }),
    updateIntegration: defineRoute({
        id: 'updateIntegration',
        method: 'PATCH',
        path: '/integrations/{integrationId}',
        summary: 'Rename an integration or change its URL or secret references',
        permission: 'integrations.manage',
        capability,
        params: IntegrationParams,
        body: { kind: 'json', schema: UpdateIntegrationBody },
        responses: { 200: one },
        problems: ['name-taken'],
    }),
    deleteIntegration: defineRoute({
        id: 'deleteIntegration',
        method: 'DELETE',
        path: '/integrations/{integrationId}',
        summary: 'Remove an integration; the secrets it referenced stay in the wallet',
        permission: 'integrations.manage',
        capability,
        params: IntegrationParams,
        responses: { 204: { kind: 'empty' } },
    }),
    enableIntegration: defineRoute({
        id: 'enableIntegration',
        method: 'POST',
        path: '/integrations/{integrationId}/enable',
        summary: 'Reconnect a disconnected integration (idempotent)',
        permission: 'integrations.manage',
        capability,
        params: IntegrationParams,
        responses: { 200: one },
    }),
    disableIntegration: defineRoute({
        id: 'disableIntegration',
        method: 'POST',
        path: '/integrations/{integrationId}/disable',
        summary: 'Disconnect an integration so agents stop using it (idempotent)',
        permission: 'integrations.manage',
        capability,
        params: IntegrationParams,
        responses: { 200: one },
    }),
    checkIntegration: defineRoute({
        id: 'checkIntegration',
        method: 'POST',
        path: '/integrations/{integrationId}/check',
        summary: 'Re-test the connection and refresh status and tools',
        permission: 'integrations.manage',
        capability,
        params: IntegrationParams,
        responses: { 200: one },
    }),
} as const;
