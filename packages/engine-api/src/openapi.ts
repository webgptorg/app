import { z } from 'zod';

import {
    Agent,
    AgentPage,
    AgentProfile,
    AgentRunState,
    AgentRunStatus,
    AgentSource,
    AgentVisibility,
    Revision,
    RevisionPage,
    RevisionSummary,
} from './agents';
import { ApiToken, ApiTokenPage, CreateApiTokenResult } from './api-tokens';
import {
    AuditAction,
    AuditActor,
    AuditDetails,
    AuditDetailsValue,
    AuditEntry,
    AuditPage,
    AuditTarget,
    AuditVerification,
} from './audit';
import { Activity, ActivityActor, ActivityPage } from './capabilities/activity';
import { AiTool, AiToolList, AiToolSignIn } from './capabilities/ai-tools';
import { CapabilityRef, capabilityLabel } from './capabilities/capability';
import {
    FileMetadata,
    FilePage,
    FilePurpose,
    FileScanStatus,
    FileVersion,
    FileVersionPage,
} from './capabilities/files';
import { Integration, IntegrationPage, IntegrationStatus, SecretRef } from './capabilities/integrations';
import {
    WalletOverview,
    WalletRecord,
    WalletRecordId,
    WalletRequest,
    WalletRequestId,
    WalletSaved,
    WalletState,
} from './capabilities/wallet';
import {
    Money,
    ProjectChange,
    Run,
    RunDetail,
    RunError,
    RunPage,
    RunProgress,
    RunSource,
    RunStats,
    RunStatus,
    RunUsage,
    ToolCall,
} from './capabilities/runs';
import {
    Recurrence,
    ScheduleConfig,
    Trigger,
    TriggerFire,
    TriggerFirePage,
    TriggerPage,
} from './capabilities/triggers';
import {
    Chat,
    ChatEntry,
    ChatEntryPage,
    ChatPage,
    ChatQuestion,
    Message,
    Participant,
    ParticipantRef,
    ReplyStreamEvent,
    SendMessageResult,
} from './chats';
import {
    ActivityId,
    AgentId,
    AgentPermanentId,
    AiToolId,
    AiToolSignInId,
    ApiTokenId,
    AuditEntryId,
    ChatId,
    ClientInfo,
    Diagnostic,
    EngineId,
    FileId,
    FileVersionId,
    FolderId,
    Hostname,
    IntegrationId,
    InviteId,
    MemberId,
    MessageId,
    OrgId,
    PasskeyId,
    ProblemDetails,
    RevisionId,
    RunId,
    SecretId,
    SemVer,
    SessionId,
    Sha256Hex,
    Timestamp,
    ToolCallId,
    TriggerFireId,
    TriggerId,
} from './common';
import { ENGINE_API_PREFIX, ENGINE_API_VERSION } from './constants';
import { EngineInfo } from './engine';
import { EngineEvent } from './events';
import { Folder, FolderPage } from './folders';
import { Me } from './me';
import { CreateInviteResult, Invite, InvitePage, Member, MemberPage } from './members';
import { Passkey, PasskeyPage } from './passkeys';
import { Permission, Role } from './permissions';
import { PROBLEM_STATUS, type ProblemCode } from './problem-codes';
import type { RouteDefinition, RouteResponse } from './route';
import { ENGINE_API_ROUTE_LIST, commonProblems } from './routes';
import { SecurityOverview, UiUpdateCheck, UnexpectedCertificate } from './security';
import { Session, SessionPage } from './sessions';
import { Settings, UpdatePolicy } from './settings';

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface OpenApiDocument {
    readonly openapi: '3.1.0';
    readonly jsonSchemaDialect: string;
    readonly info: { readonly title: string; readonly version: string; readonly license: JsonSchema };
    readonly servers: readonly { readonly url: string }[];
    readonly security: readonly Readonly<Record<string, readonly string[]>>[];
    readonly paths: Readonly<Record<string, Readonly<Record<string, JsonSchema>>>>;
    readonly components: {
        readonly schemas: Readonly<Record<string, JsonSchema>>;
        readonly securitySchemes: Readonly<Record<string, JsonSchema>>;
    };
}

/** Schemas emitted once under `components.schemas` and referenced by name everywhere else. */
const COMPONENT_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
    OrgId,
    AgentId,
    AgentPermanentId,
    FolderId,
    RevisionId,
    ChatId,
    MessageId,
    MemberId,
    InviteId,
    ApiTokenId,
    SecretId,
    FileId,
    AuditEntryId,
    PasskeyId,
    SessionId,
    RunId,
    ToolCallId,
    TriggerId,
    TriggerFireId,
    IntegrationId,
    ActivityId,
    FileVersionId,
    EngineId,
    Timestamp,
    Hostname,
    SemVer,
    Sha256Hex,
    Role,
    Permission,
    Diagnostic,
    ProblemDetails,
    ClientInfo,
    Me,
    CapabilityRef,
    EngineInfo,
    AgentVisibility,
    AgentRunState,
    AgentProfile,
    Agent,
    AgentPage,
    AgentSource,
    RevisionSummary,
    RevisionPage,
    Revision,
    AgentRunStatus,
    EngineEvent,
    Folder,
    FolderPage,
    ParticipantRef,
    Participant,
    ChatQuestion,
    Chat,
    ChatPage,
    Message,
    ChatEntry,
    ChatEntryPage,
    SendMessageResult,
    ReplyStreamEvent,
    Member,
    MemberPage,
    Invite,
    InvitePage,
    CreateInviteResult,
    ApiToken,
    ApiTokenPage,
    CreateApiTokenResult,
    UpdatePolicy,
    Settings,
    Passkey,
    PasskeyPage,
    Session,
    SessionPage,
    UiUpdateCheck,
    UnexpectedCertificate,
    SecurityOverview,
    AuditAction,
    AuditActor,
    AuditTarget,
    AuditDetails,
    AuditDetailsValue,
    AuditEntry,
    AuditPage,
    AuditVerification,
    ActivityActor,
    Activity,
    ActivityPage,
    RunSource,
    RunStatus,
    Money,
    RunUsage,
    RunError,
    RunProgress,
    Run,
    RunPage,
    ToolCall,
    ProjectChange,
    RunDetail,
    RunStats,
    FilePurpose,
    FileScanStatus,
    FileMetadata,
    FilePage,
    FileVersion,
    FileVersionPage,
    Recurrence,
    ScheduleConfig,
    Trigger,
    TriggerPage,
    TriggerFire,
    TriggerFirePage,
    IntegrationStatus,
    SecretRef,
    Integration,
    IntegrationPage,
    WalletRecordId,
    WalletRequestId,
    WalletState,
    WalletRecord,
    WalletRequest,
    WalletOverview,
    WalletSaved,
    AiToolId,
    AiToolSignInId,
    AiTool,
    AiToolList,
    AiToolSignIn,
};

const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const SESSION_COOKIE = '__Host-ptbk-session';
const PROBLEM_REF = { $ref: '#/components/schemas/ProblemDetails' };

type Io = 'input' | 'output';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rewriteRefs(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(rewriteRefs);
    if (!isRecord(node)) return node;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
        if (key === '$schema') continue;
        result[key] =
            key === '$ref' && typeof value === 'string'
                ? value.replace(/^#\/\$defs\//, '#/components/schemas/')
                : rewriteRefs(value);
    }
    return result;
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (!isRecord(value)) return JSON.stringify(value);
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

class ComponentCollector {
    readonly schemas: Record<string, JsonSchema> = {};
    readonly #registry = z.registry<{ id: string }>();

    constructor(components: Readonly<Record<string, z.ZodType>>) {
        for (const [id, schema] of Object.entries(components)) this.#registry.add(schema, { id });
    }

    /** Converts a schema, hoisting every named schema it uses into `components.schemas`. */
    convert(schema: z.ZodType, io: Io): JsonSchema {
        const converted = z.toJSONSchema(schema, { metadata: this.#registry, io, target: 'draft-2020-12' });
        const { $defs, ...rest } = converted as Record<string, unknown>;
        if (isRecord($defs)) {
            for (const [id, definition] of Object.entries($defs))
                this.#hoist(id, rewriteRefs(definition) as JsonSchema);
        }
        return rewriteRefs(rest) as JsonSchema;
    }

    #hoist(id: string, definition: JsonSchema): void {
        const existing = this.schemas[id];
        if (existing === undefined) {
            this.schemas[id] = definition;
        } else if (stableStringify(existing) !== stableStringify(definition)) {
            // Input and output forms of a named schema differ (a default or transform inside it): name them apart.
            throw new Error(`OpenAPI component ${id} has conflicting definitions`);
        }
    }
}

function shapeOf(schema: z.ZodObject | undefined): [string, z.ZodType][] {
    const shape: Readonly<Record<string, z.ZodType>> = schema?.shape ?? {};
    return Object.entries(shape);
}

function tagOf(route: RouteDefinition): string {
    return route.path.split('/')[1] ?? 'engine';
}

function parametersOf(route: RouteDefinition, components: ComponentCollector): JsonSchema[] {
    const parameters: JsonSchema[] = [];
    for (const [name, schema] of shapeOf(route.params)) {
        parameters.push({ name, in: 'path', required: true, schema: components.convert(schema, 'input') });
    }
    if (route.query) {
        const required = new Set(
            (components.convert(route.query, 'input')['required'] as readonly string[] | undefined) ?? [],
        );
        for (const [name, schema] of shapeOf(route.query)) {
            parameters.push({
                name,
                in: 'query',
                required: required.has(name),
                schema: components.convert(schema, 'input'),
            });
        }
    }
    if (Object.values(route.responses).some((response) => response.kind === 'sse')) {
        parameters.push({
            name: 'Last-Event-ID',
            in: 'header',
            required: false,
            description: 'Resume after this SSE id.',
            schema: { type: 'string' },
        });
    }
    return parameters;
}

function requestBodyOf(route: RouteDefinition, components: ComponentCollector): JsonSchema | undefined {
    const body = route.body;
    if (!body) return undefined;
    switch (body.kind) {
        case 'json':
            return {
                required: true,
                content: { 'application/json': { schema: components.convert(body.schema, 'input') } },
            };
        case 'multipart': {
            const properties: Record<string, JsonSchema> = {};
            for (const [name, schema] of shapeOf(body.schema)) {
                properties[name] =
                    schema instanceof z.ZodCustom
                        ? { type: 'string', contentMediaType: 'application/octet-stream' }
                        : components.convert(schema, 'input');
            }
            return {
                required: true,
                content: {
                    'multipart/form-data': {
                        schema: {
                            type: 'object',
                            properties,
                            required: Object.keys(properties),
                            additionalProperties: false,
                        },
                    },
                },
            };
        }
        case 'binary':
            return {
                required: true,
                description: `The raw bytes, at most ${String(body.maxBytes)}.`,
                content: Object.fromEntries(
                    body.mediaTypes.map((type) => [type, { schema: { type: 'string', contentMediaType: type } }]),
                ),
            };
    }
}

function successResponseOf(response: RouteResponse, components: ComponentCollector): JsonSchema {
    switch (response.kind) {
        case 'json':
            return {
                description: 'Success.',
                content: { 'application/json': { schema: components.convert(response.schema, 'output') } },
            };
        case 'empty':
            return { description: 'Success, no content.' };
        case 'sse':
            return {
                description:
                    "Server-sent events; each event's `type` is also its SSE `event` field, and `data` is the event as JSON.",
                content: { 'text/event-stream': { schema: components.convert(response.event, 'output') } },
            };
        case 'binary': {
            const types = response.mediaTypes ?? ['application/octet-stream'];
            return {
                description: response.mediaTypes === undefined ? 'The bytes.' : 'The bytes, in one of these formats.',
                content: Object.fromEntries(
                    types.map((type) => [type, { schema: { type: 'string', contentMediaType: type } }]),
                ),
            };
        }
    }
}

function problemResponsesOf(route: RouteDefinition): Record<string, JsonSchema> {
    const codes = new Set<ProblemCode>([...commonProblems(route), ...(route.problems ?? [])]);
    const byStatus = new Map<number, ProblemCode[]>();
    for (const code of codes) {
        const status = PROBLEM_STATUS[code];
        byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
    }
    const responses: Record<string, JsonSchema> = {};
    for (const status of [...byStatus.keys()].sort((a, b) => a - b)) {
        const statusCodes = (byStatus.get(status) ?? []).sort();
        responses[String(status)] = {
            description: `Problem: ${statusCodes.map((code) => `\`${code}\``).join(', ')}.`,
            'x-problem-codes': statusCodes,
            content: { 'application/problem+json': { schema: PROBLEM_REF } },
        };
    }
    return responses;
}

function operationOf(route: RouteDefinition, components: ComponentCollector): JsonSchema {
    const responses: Record<string, JsonSchema> = {};
    for (const [status, response] of Object.entries(route.responses)) {
        responses[status] = successResponseOf(response, components);
    }
    Object.assign(responses, problemResponsesOf(route));
    const parameters = parametersOf(route, components);
    const requestBody = requestBodyOf(route, components);
    return {
        operationId: route.id,
        summary: route.summary,
        ...(route.description === undefined ? {} : { description: route.description }),
        tags: [tagOf(route)],
        'x-required-permission': route.permission,
        ...(route.capability
            ? {
                  'x-capability': {
                      id: route.capability.id,
                      version: route.capability.version,
                      label: capabilityLabel(route.capability),
                  },
              }
            : {}),
        ...(route.stepUp ? { 'x-step-up': true } : {}),
        ...(route.draft ? { 'x-draft': true } : {}),
        ...(parameters.length > 0 ? { parameters } : {}),
        ...(requestBody ? { requestBody } : {}),
        responses,
    };
}

/** The OpenAPI 3.1 document for the engine API, generated from `ENGINE_API_ROUTES`. */
export function buildOpenApiDocument(): OpenApiDocument {
    const components = new ComponentCollector(COMPONENT_SCHEMAS);
    const paths: Record<string, Record<string, JsonSchema>> = {};
    for (const route of ENGINE_API_ROUTE_LIST) {
        const operations = (paths[route.path] ??= {});
        operations[route.method.toLowerCase()] = operationOf(route, components);
    }
    for (const schema of Object.values(COMPONENT_SCHEMAS)) components.convert(schema, 'output');
    const sortedSchemas = Object.fromEntries(
        Object.entries(components.schemas).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    return {
        openapi: '3.1.0',
        jsonSchemaDialect: JSON_SCHEMA_DIALECT,
        info: {
            title: 'Promptbook engine API',
            version: ENGINE_API_VERSION,
            license: { name: 'MIT', identifier: 'MIT' },
        },
        servers: [{ url: ENGINE_API_PREFIX }],
        security: [{ sessionCookie: [] }],
        paths,
        components: {
            schemas: sortedSchemas,
            securitySchemes: {
                sessionCookie: {
                    type: 'apiKey',
                    in: 'cookie',
                    name: SESSION_COOKIE,
                    description:
                        "The gateway's `__Host-` HttpOnly, SameSite=Strict session cookie. Its name is the gateway's choice and shown here for illustration; requests must also be same-origin (Fetch Metadata).",
                },
            },
        },
    };
}
