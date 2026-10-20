import type { z } from 'zod';

import { Agent, AgentRunState } from './agents';
import type { AgentVisibility } from './agents';
import { ApiToken } from './api-tokens';
import { AuditEntry } from './audit';
import type { AuditAction } from './audit';
import { Activity } from './capabilities/activity';
import { CapabilityRef, KNOWN_CAPABILITIES, supports } from './capabilities/capability';
import { FileMetadata, FileVersion } from './capabilities/files';
import { Integration } from './capabilities/integrations';
import { RunDetail } from './capabilities/runs';
import type { Run } from './capabilities/runs';
import { Trigger, TriggerFire } from './capabilities/triggers';
import { Chat, Message } from './chats';
import { createEngineApiClient, EngineApiContractError } from './client';
import type { EngineApiClient, EngineApiResponse, EngineApiTransport } from './client';
import {
    AgentId,
    AgentPermanentId,
    AuditEntryId,
    ClientInfo,
    FolderId,
    MemberId,
    OpaqueId,
    OrgId,
    RevisionId,
    Timestamp,
} from './common';
import type { ProblemDetails } from './common';
import { EngineInfo } from './engine';
import { EngineEvent } from './events';
import { Folder } from './folders';
import { hashAuditEntry } from './in-memory/audit-chain';
import { checkBook } from './in-memory/book';
import { HANDLERS } from './in-memory/handlers';
import type { HandlerContext, ReplyScript } from './in-memory/handlers';
import { recordActivity } from './in-memory/kit';
import type { ActivityInput, EngineContext } from './in-memory/kit';
import { advanceRun } from './in-memory/runs';
import type { RunOutcome } from './in-memory/runs';
import type { FileRecord, InMemoryState } from './in-memory/state';
import { fireTrigger } from './in-memory/triggers';
import { withClientReading } from './reader';
import { Invite, Member } from './members';
import { Passkey } from './passkeys';
import { OWNER_PERMISSIONS } from './permissions';
import type { Permission, Role } from './permissions';
import { createProblem } from './problem';
import type { EngineApiStreamItem, ParsedRouteRequest, RouteDefinition } from './route';
import type { EngineApiRouteId } from './routes';
import { SecretMetadata } from './secrets';
import { SecurityOverview } from './security';
import { Session } from './sessions';
import { Settings } from './settings';

/**
 * Present in every build that includes the in-memory client, so a production bundle can be checked for its absence
 * (U-01). Do not use it for anything else.
 */
export const IN_MEMORY_CLIENT_MARKER = 'ptbk-engine-api-in-memory-client';

export interface Clock {
    now(): Date;
}

/** Who the client acts as. Permissions are explicit, so tests can cover a member who lacks one. */
export interface InMemoryMember {
    readonly id?: string;
    readonly displayName?: string;
    readonly role?: Role;
    readonly permissions?: readonly Permission[];
}

/** A contract shape with plain strings where the schema brands, since seeds are parsed anyway. */
type Unbranded<T> = T extends string & z.$brand<string>
    ? string
    : T extends readonly (infer Item)[]
      ? readonly Unbranded<Item>[]
      : T extends Blob
        ? T
        : T extends object
          ? { readonly [Key in keyof T]: Unbranded<T[Key]> }
          : T;

/** An agent is seeded from its book source, like the engine would create it; name and profile come from the book. */
export interface InMemorySeedAgent {
    readonly source: string;
    readonly id?: string;
    readonly createdBy?: string;
    readonly visibility?: AgentVisibility;
    readonly folderId?: string;
    readonly createdAt?: string;
    readonly deletedAt?: string;
    readonly runState?: AgentRunState;
}

/** A finished audit entry minus what the chain computes (`id`, `seq`, `hash`, `prevHash`). */
export type InMemorySeedAuditEntry = Omit<Unbranded<z.input<typeof AuditEntry>>, 'id' | 'seq' | 'hash' | 'prevHash'>;

/** Seed data in contract shapes; every record is validated against its schema when the client is created. */
export interface InMemorySeed {
    readonly orgId?: string;
    /** `engineId` defaults to a fixed ID; `capabilities` come from the `capabilities` option. */
    readonly engine?: Omit<Unbranded<z.input<typeof EngineInfo>>, 'engineId' | 'capabilities'> & {
        readonly engineId?: string;
    };
    readonly settings?: Unbranded<z.input<typeof Settings>>;
    readonly security?: Unbranded<z.input<typeof SecurityOverview>>;
    readonly members?: readonly Unbranded<z.input<typeof Member>>[];
    readonly invites?: readonly Unbranded<z.input<typeof Invite>>[];
    readonly folders?: readonly Unbranded<z.input<typeof Folder>>[];
    readonly agents?: readonly InMemorySeedAgent[];
    readonly chats?: readonly Unbranded<z.input<typeof Chat>>[];
    readonly messages?: readonly Unbranded<z.input<typeof Message>>[];
    readonly secrets?: readonly Unbranded<z.input<typeof SecretMetadata>>[];
    readonly apiTokens?: readonly Unbranded<z.input<typeof ApiToken>>[];
    readonly passkeys?: readonly Unbranded<z.input<typeof Passkey>>[];
    readonly sessions?: readonly Unbranded<z.input<typeof Session>>[];
    readonly files?: readonly InMemorySeedFile[];
    readonly runs?: readonly Unbranded<z.input<typeof RunDetail>>[];
    readonly triggers?: readonly {
        readonly trigger: Unbranded<z.input<typeof Trigger>>;
        /** Oldest first. */
        readonly fires?: readonly Unbranded<z.input<typeof TriggerFire>>[];
    }[];
    readonly integrations?: readonly Unbranded<z.input<typeof Integration>>[];
    /** Oldest first. */
    readonly activity?: readonly Unbranded<z.input<typeof Activity>>[];
    readonly auditEntries?: readonly InMemorySeedAuditEntry[];
}

/** `versions` (oldest first) default to one version with `content`; `versionCount` is derived from them. */
export interface InMemorySeedFile {
    readonly metadata: Omit<Unbranded<z.input<typeof FileMetadata>>, 'versionCount'>;
    readonly content: Blob;
    readonly versions?: readonly { readonly version: Unbranded<z.input<typeof FileVersion>>; readonly content: Blob }[];
}

export interface InMemoryEngineApiOptions {
    readonly seed?: InMemorySeed;
    readonly clock?: Clock;
    readonly member?: InMemoryMember;
    /** `required` makes every `stepUp` route answer 401 `step-up-required`, as the gateway does without a fresh assertion. */
    readonly stepUp?: 'satisfied' | 'required';
    readonly replyScript?: ReplyScript;
    /** Recorded in audit entries as the request's origin. */
    readonly client?: Unbranded<z.input<typeof ClientInfo>>;
    /** What `GET /engine` advertises; routes of any other capability answer 404 `capability-not-supported`. */
    readonly capabilities?: readonly Unbranded<CapabilityRef>[];
}

/**
 * Test-only levers on the in-memory engine, for what the engine does on its own: runs progressing, schedules coming
 * due, things happening elsewhere. Timestamps come from the injected clock, so UI tests stay deterministic.
 */
export interface InMemoryEngineController {
    /** Appends to the activity feed (stamped with an ID and the clock) and announces it on the event stream. */
    appendActivity(activity: Unbranded<ActivityInput>): Activity;
    /** Starts a queued run, or ends a running one with `outcome` (default `completed`; `cancelled` if requested). */
    advanceRun(runId: string, outcome?: Unbranded<RunOutcome>): Run;
    /** A schedule comes due, or an email arrives for an email trigger. */
    fireTrigger(triggerId: string): TriggerFire;
    /** Sends an event as is, e.g. a change made by another member. */
    emit(event: Unbranded<z.input<typeof EngineEvent>>): void;
}

export interface InMemoryEngine {
    readonly client: EngineApiClient;
    readonly controller: InMemoryEngineController;
}

/**
 * The engine API on plain maps, for engine-ui tests and offline development. It keeps the contract's observable
 * rules: strict input validation, permission checks, cursor paging, soft delete, revision conflicts, secrets without
 * values, an audit hash chain and scripted streamed replies.
 */
export function createInMemoryEngineApiClient(options: InMemoryEngineApiOptions = {}): EngineApiClient {
    return createInMemoryEngine(options).client;
}

/** The in-memory client together with its test-only controller. */
export function createInMemoryEngine(options: InMemoryEngineApiOptions = {}): InMemoryEngine {
    const engine = createEngine(options);
    const client = createEngineApiClient(withClientReading(engine.transport));
    return {
        client: Object.defineProperty(client, Symbol.toStringTag, { value: IN_MEMORY_CLIENT_MARKER }),
        controller: engine.controller,
    };
}

const DEFAULT_REPLY_SCRIPT: ReplyScript = ({ agent, content }) => ({
    chunks: `${agent.name} received: ${content}`.split(/(?<= )/),
});

/**
 * The engine side of the in-memory client: it resolves with exactly what an engine would send (strictly checked), so
 * the tests can serve it over HTTP to drive the fetch client.
 */
export function createInMemoryEngineApiTransport(options: InMemoryEngineApiOptions = {}): EngineApiTransport {
    return createEngine(options).transport;
}

/** Engine transport and controller over one state, for tests that drive the fetch client and the engine together. */
export function createInMemoryEngineParts(options: InMemoryEngineApiOptions = {}): {
    readonly transport: EngineApiTransport;
    readonly controller: InMemoryEngineController;
} {
    return createEngine(options);
}

function createEngine(options: InMemoryEngineApiOptions): {
    readonly transport: EngineApiTransport;
    readonly controller: InMemoryEngineController;
} {
    const clock = options.clock ?? { now: () => new Date() };
    const now = (): Timestamp => Timestamp.parse(clock.now().toISOString());
    const permissions = new Set(options.member?.permissions ?? OWNER_PERMISSIONS);
    const member = Member.parse({
        id: options.member?.id ?? 'member-owner',
        displayName: options.member?.displayName ?? 'Owner',
        role: options.member?.role ?? 'owner',
        status: 'active',
        createdAt: now(),
        lastSeenAt: now(),
    });
    const client = ClientInfo.parse(options.client ?? { ip: '127.0.0.1', userAgent: 'in-memory engine API client' });
    const capabilities = (options.capabilities ?? Object.values(KNOWN_CAPABILITIES)).map((ref) =>
        CapabilityRef.parse(ref),
    );
    const state = createState(options.seed ?? {}, member, now, capabilities);
    const counters = new Map<string, number>();
    const waiters = new Set<() => void>();
    // Appends are serialised so each entry hashes over the previous one.
    let auditTail: Promise<unknown> = seedAudit(state, options.seed?.auditEntries ?? []);

    const newId: HandlerContext['newId'] = (schema, prefix) => {
        for (;;) {
            const next = (counters.get(prefix) ?? 0) + 1;
            counters.set(prefix, next);
            const id = `${prefix}-${String(next).padStart(6, '0')}`;
            if (!idTaken(state, id)) return schema.parse(id);
        }
    };
    const publish = (event: EngineEvent): void => {
        state.events.push({ id: String(state.events.length + 1), event });
        for (const wake of waiters) wake();
    };
    const nextEvent = (count: number, signal: AbortSignal): Promise<void> =>
        new Promise((resolve, reject) => {
            if (state.events.length > count) {
                resolve();
                return;
            }
            const wake = (): void => {
                cleanup();
                resolve();
            };
            const abort = (): void => {
                cleanup();
                reject(signal.reason as Error);
            };
            const cleanup = (): void => {
                waiters.delete(wake);
                signal.removeEventListener('abort', abort);
            };
            if (signal.aborted) {
                abort();
                return;
            }
            waiters.add(wake);
            signal.addEventListener('abort', abort, { once: true });
        });
    const audit = (action: AuditAction, target: AuditEntry['target'], outcome: AuditEntry['outcome']): void => {
        const at = now();
        auditTail = auditTail.then(async () => {
            const previous = state.audit.at(-1);
            const seq = (previous?.seq ?? 0) + 1;
            const entry = {
                id: AuditEntryId.parse(`audit-${String(seq).padStart(6, '0')}`),
                seq,
                at,
                actor: { kind: 'member' as const, memberId: member.id },
                action,
                target,
                outcome,
                client,
                prevHash: previous?.hash ?? null,
            };
            state.audit.push({ ...entry, hash: await hashAuditEntry(entry) });
        });
    };

    const system: EngineContext = { state, now, newId, publish };
    const controller: InMemoryEngineController = {
        appendActivity: (activity) => recordActivity(system, activity as ActivityInput),
        advanceRun: (runId, outcome) => advanceRun(system, runId, outcome),
        fireTrigger: (triggerId) => fireTrigger(system, triggerId),
        emit: (event) => {
            publish(EngineEvent.parse(event));
        },
    };

    const transport: EngineApiTransport = async (route, request, signal) => {
        signal.throwIfAborted();
        await auditTail;
        // An engine without the capability has no such route, whoever asks.
        if (route.capability && !supports(state.engine, route.capability)) {
            return { kind: 'problem', problem: createProblem('capability-not-supported') };
        }
        const routeId = route.id as EngineApiRouteId;
        const audited = AUDITED[routeId];
        const deny = (problem: ProblemDetails): EngineApiResponse<never> => {
            if (audited) audit(audited.action, auditTarget(audited, request.params, undefined), 'denied');
            return { kind: 'problem', problem };
        };
        if (route.permission !== null && !permissions.has(route.permission)) {
            return deny(createProblem('forbidden', { requiredPermission: route.permission }));
        }
        if (route.stepUp && options.stepUp === 'required') return deny(createProblem('step-up-required'));
        const parsed = parseRequest(route, request);
        if (parsed.kind === 'problem') {
            if (audited) audit(audited.action, auditTarget(audited, request.params, undefined), 'failed');
            return parsed;
        }
        const handler = HANDLERS[routeId] as (
            request: ParsedRouteRequest<RouteDefinition>,
            ctx: HandlerContext,
        ) => ReturnType<(typeof HANDLERS)[EngineApiRouteId]>;
        const result = await handler(parsed.request, {
            state,
            member,
            permissions,
            now,
            newId,
            publish,
            nextEvent,
            replyScript: options.replyScript ?? DEFAULT_REPLY_SCRIPT,
            signal,
        });
        if (audited) {
            const outcome = result.kind === 'ok' ? 'success' : 'failed';
            audit(
                audited.action,
                auditTarget(audited, parsed.request.params, result.kind === 'ok' ? result.data : undefined),
                outcome,
            );
        }
        if (result.kind === 'problem') return result;
        return { kind: 'ok', data: checkSuccess(route, result.data) };
    };
    return { transport, controller };
}

type ParseOutcome =
    | { readonly kind: 'ok'; readonly request: ParsedRouteRequest<RouteDefinition> }
    | { readonly kind: 'problem'; readonly problem: ProblemDetails };

function parseRequest(route: RouteDefinition, request: Parameters<EngineApiTransport>[1]): ParseOutcome {
    const errors: { path: string; message: string }[] = [];
    const part = (location: string, schema: z.ZodType | undefined, value: unknown): unknown => {
        if (!schema) {
            const empty =
                value === undefined || (typeof value === 'object' && value !== null && Object.keys(value).length === 0);
            if (!empty) errors.push({ path: location, message: 'Not allowed for this route.' });
            return location === 'body' ? undefined : {};
        }
        const result = schema.safeParse(value ?? (location === 'body' ? undefined : {}));
        if (result.success) return result.data;
        for (const issue of result.error.issues) {
            errors.push({ path: [location, ...issue.path.map(String)].join('.'), message: issue.message });
        }
        return undefined;
    };
    const params = part('params', route.params, request.params);
    const query = part('query', route.query, request.query);
    const body = part('body', route.body?.schema, request.body);
    if (errors.length > 0) return { kind: 'problem', problem: createProblem('validation-failed', { errors }) };
    return {
        kind: 'ok',
        request: {
            params,
            query,
            body,
            lastEventId: request.lastEventId ?? null,
        } as ParsedRouteRequest<RouteDefinition>,
    };
}

/** A fake that answers outside its own contract is a bug, reported the way the fetch client reports the engine's. */
function checkSuccess(route: RouteDefinition, data: unknown): unknown {
    const [success] = Object.values(route.responses);
    switch (success?.kind) {
        case 'json': {
            const result = success.schema.safeParse(data);
            if (!result.success)
                throw new EngineApiContractError(route.id, 'in-memory response does not match the schema', {
                    cause: result.error,
                });
            return result.data;
        }
        case 'sse':
            return checkStream(route, success.event, data as AsyncIterable<EngineApiStreamItem<unknown>>);
        case 'empty':
        case 'binary':
        case undefined:
            return data;
    }
}

async function* checkStream(
    route: RouteDefinition,
    schema: z.ZodType,
    items: AsyncIterable<EngineApiStreamItem<unknown>>,
): AsyncIterable<EngineApiStreamItem<unknown>> {
    for await (const item of items) {
        const result = schema.safeParse(item.event);
        if (!result.success)
            throw new EngineApiContractError(route.id, 'in-memory stream event does not match the schema', {
                cause: result.error,
            });
        yield { id: item.id, event: result.data };
    }
}

interface AuditRule {
    readonly action: AuditAction;
    readonly kind: NonNullable<AuditEntry['target']>['kind'] | null;
    /** Path parameter naming the target, or `undefined` when the target is the created resource. */
    readonly param?: string;
}

const AUDITED: Partial<Record<EngineApiRouteId, AuditRule>> = {
    createAgent: { action: 'agent.create', kind: 'agent' },
    updateAgent: { action: 'agent.update', kind: 'agent', param: 'agentId' },
    deleteAgent: { action: 'agent.delete', kind: 'agent', param: 'agentId' },
    restoreAgent: { action: 'agent.restore', kind: 'agent', param: 'agentId' },
    updateAgentSource: { action: 'agent.source.update', kind: 'agent', param: 'agentId' },
    startAgent: { action: 'agent.start', kind: 'agent', param: 'agentId' },
    stopAgent: { action: 'agent.stop', kind: 'agent', param: 'agentId' },
    createFolder: { action: 'folder.create', kind: 'folder' },
    renameFolder: { action: 'folder.rename', kind: 'folder', param: 'folderId' },
    deleteFolder: { action: 'folder.delete', kind: 'folder', param: 'folderId' },
    createChat: { action: 'chat.create', kind: 'chat' },
    sendChatMessage: { action: 'chat.message.send', kind: 'chat', param: 'chatId' },
    cancelChatReply: { action: 'chat.reply.cancel', kind: 'message', param: 'messageId' },
    updateMember: { action: 'member.update', kind: 'member', param: 'memberId' },
    removeMember: { action: 'member.remove', kind: 'member', param: 'memberId' },
    createInvite: { action: 'invite.create', kind: 'invite' },
    revokeInvite: { action: 'invite.revoke', kind: 'invite', param: 'inviteId' },
    createApiToken: { action: 'api-token.create', kind: 'api-token' },
    revokeApiToken: { action: 'api-token.revoke', kind: 'api-token', param: 'apiTokenId' },
    updateSettings: { action: 'settings.update', kind: null },
    setUpdatePolicy: { action: 'settings.update-policy', kind: null },
    revokePasskey: { action: 'passkey.revoke', kind: 'passkey', param: 'passkeyId' },
    revokeSession: { action: 'session.revoke', kind: 'session', param: 'sessionId' },
    revokeMyPasskey: { action: 'passkey.revoke', kind: 'passkey', param: 'passkeyId' },
    revokeMySession: { action: 'session.revoke', kind: 'session', param: 'sessionId' },
    revokeMyOtherSessions: { action: 'session.revoke-others', kind: null },
    createSecret: { action: 'secret.create', kind: 'secret' },
    replaceSecretValue: { action: 'secret.replace', kind: 'secret', param: 'secretId' },
    revokeSecret: { action: 'secret.revoke', kind: 'secret', param: 'secretId' },
    deleteSecret: { action: 'secret.delete', kind: 'secret', param: 'secretId' },
    uploadFile: { action: 'file.upload', kind: 'file' },
    deleteFile: { action: 'file.delete', kind: 'file', param: 'fileId' },
    cancelRun: { action: 'run.cancel', kind: 'run', param: 'runId' },
    retryRun: { action: 'run.retry', kind: 'run', param: 'runId' },
    createTrigger: { action: 'trigger.create', kind: 'trigger' },
    updateTrigger: { action: 'trigger.update', kind: 'trigger', param: 'triggerId' },
    pauseTrigger: { action: 'trigger.pause', kind: 'trigger', param: 'triggerId' },
    resumeTrigger: { action: 'trigger.resume', kind: 'trigger', param: 'triggerId' },
    deleteTrigger: { action: 'trigger.delete', kind: 'trigger', param: 'triggerId' },
    createIntegration: { action: 'integration.create', kind: 'integration' },
    updateIntegration: { action: 'integration.update', kind: 'integration', param: 'integrationId' },
    enableIntegration: { action: 'integration.enable', kind: 'integration', param: 'integrationId' },
    disableIntegration: { action: 'integration.disable', kind: 'integration', param: 'integrationId' },
    deleteIntegration: { action: 'integration.delete', kind: 'integration', param: 'integrationId' },
};

function auditTarget(rule: AuditRule, params: unknown, created: unknown): AuditEntry['target'] {
    if (rule.kind === null) return null;
    const id =
        rule.param === undefined ? createdId(created) : (params as Record<string, unknown> | undefined)?.[rule.param];
    const parsed = OpaqueId.safeParse(id);
    return parsed.success ? { kind: rule.kind, id: parsed.data } : null;
}

/** Created resources come back either directly or wrapped (`{ invite }`, `{ apiToken }`). */
function createdId(created: unknown): unknown {
    if (typeof created !== 'object' || created === null) return undefined;
    const record = created as Record<string, unknown>;
    if ('id' in record) return record['id'];
    const wrapped = record['invite'] ?? record['apiToken'];
    return typeof wrapped === 'object' && wrapped !== null ? (wrapped as Record<string, unknown>)['id'] : undefined;
}

function idTaken(state: InMemoryState, id: string): boolean {
    return (
        [
            state.members,
            state.invites,
            state.folders,
            state.agents,
            state.chats,
            state.messages,
            state.secrets,
            state.apiTokens,
            state.passkeys,
            state.sessions,
            state.files,
            state.runs,
            state.triggers,
            state.integrations,
        ].some((map) => map.has(id)) ||
        [...state.agents.values()].some(({ revisions }) => revisions.some((revision) => revision.id === id)) ||
        [...state.files.values()].some(({ versions }) => versions.some(({ version }) => version.id === id)) ||
        [...state.triggers.values()].some(({ fires }) => fires.some((fire) => fire.id === id)) ||
        state.activity.some((activity) => activity.id === id)
    );
}

const DEFAULT_ENGINE_ID = 'memoryengine234567abcdefgh';

function seedFile({ metadata, content, versions }: InMemorySeedFile): [string, FileRecord] {
    const versionRecords = (
        versions ?? [
            {
                version: {
                    id: `${metadata.id}-v1`,
                    createdAt: metadata.createdAt,
                    sizeBytes: metadata.sizeBytes,
                    sha256: metadata.sha256,
                    commitHash: null,
                    runId: metadata.runId,
                },
                content,
            },
        ]
    ).map((record) => ({ version: FileVersion.parse(record.version), content: record.content }));
    const parsed = FileMetadata.parse({ ...metadata, versionCount: versionRecords.length });
    return [parsed.id, { metadata: parsed, versions: versionRecords }];
}

function createState(
    seed: InMemorySeed,
    member: Member,
    now: () => Timestamp,
    capabilities: readonly CapabilityRef[],
): InMemoryState {
    const at = now();
    const byId = <T extends { readonly id: string }>(items: readonly T[]): Map<string, T> =>
        new Map(items.map((item) => [item.id, item]));
    const members = byId((seed.members ?? []).map((record) => Member.parse(record)));
    if (!members.has(member.id)) members.set(member.id, member);
    const settings = Settings.parse(
        seed.settings ?? {
            name: 'In-memory engine',
            defaultAgentVisibility: 'private',
            updatePolicy: { policy: 'auto', pinnedVersion: null },
        },
    );
    const state: InMemoryState = {
        orgId: OrgId.parse(seed.orgId ?? 'org-1'),
        engine: EngineInfo.parse({
            engineId: DEFAULT_ENGINE_ID,
            ...(seed.engine ?? {
                name: settings.name,
                hostname: 'engine.localhost',
                dashboardUrl: null,
                mode: 'local',
            }),
            capabilities,
        }),
        settings,
        security: SecurityOverview.parse(seed.security ?? defaultSecurity(at)),
        members,
        invites: byId((seed.invites ?? []).map((record) => Invite.parse(record))),
        folders: byId((seed.folders ?? []).map((record) => Folder.parse(record))),
        agents: new Map(),
        chats: byId((seed.chats ?? []).map((record) => Chat.parse(record))),
        messages: byId((seed.messages ?? []).map((record) => Message.parse(record))),
        replies: new Map(),
        secrets: byId((seed.secrets ?? []).map((record) => SecretMetadata.parse(record))),
        apiTokens: byId((seed.apiTokens ?? []).map((record) => ApiToken.parse(record))),
        passkeys: byId(
            (
                seed.passkeys ?? [
                    { id: 'passkey-owner', memberId: member.id, name: 'This device', createdAt: at, lastUsedAt: at },
                ]
            ).map((record) => Passkey.parse(record)),
        ),
        sessions: byId(
            (
                seed.sessions ?? [
                    {
                        id: 'session-current',
                        memberId: member.id,
                        current: true,
                        client: null,
                        createdAt: at,
                        lastSeenAt: at,
                        expiresAt: Timestamp.parse(new Date(Date.parse(at) + 12 * 3_600_000).toISOString()),
                    },
                ]
            ).map((record) => Session.parse(record)),
        ),
        files: new Map((seed.files ?? []).map(seedFile)),
        runs: byId((seed.runs ?? []).map((record) => RunDetail.parse(record))),
        triggers: new Map(
            (seed.triggers ?? []).map(({ trigger, fires }) => {
                const parsed = Trigger.parse(trigger);
                return [parsed.id, { trigger: parsed, fires: (fires ?? []).map((fire) => TriggerFire.parse(fire)) }];
            }),
        ),
        integrations: byId((seed.integrations ?? []).map((record) => Integration.parse(record))),
        activity: (seed.activity ?? []).map((record) => Activity.parse(record)),
        audit: [],
        events: [],
    };
    for (const [index, seedAgent] of (seed.agents ?? []).entries()) {
        const book = checkBook(seedAgent.source);
        if (book.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
            throw new Error(`Seed agent ${String(index)} has a book with errors`);
        }
        const id = AgentId.parse(seedAgent.id ?? `seed-agent-${String(index + 1).padStart(6, '0')}`);
        const createdAt = Timestamp.parse(seedAgent.createdAt ?? at);
        const createdBy = MemberId.parse(seedAgent.createdBy ?? member.id);
        const revisionId = RevisionId.parse(`${id}-r1`);
        const agent = Agent.parse({
            id,
            permanentId: AgentPermanentId.parse(`p-${id}`),
            name: book.name,
            profile: book.profile,
            visibility: seedAgent.visibility ?? settings.defaultAgentVisibility,
            folderId: seedAgent.folderId === undefined ? null : FolderId.parse(seedAgent.folderId),
            currentRevisionId: revisionId,
            createdBy,
            createdAt,
            updatedAt: createdAt,
            deletedAt: seedAgent.deletedAt ?? null,
        });
        state.agents.set(id, {
            agent,
            revisions: [{ id: revisionId, agentId: id, source: seedAgent.source, createdBy, createdAt }],
            runStatus: { state: AgentRunState.parse(seedAgent.runState ?? 'idle'), since: createdAt },
        });
    }
    return state;
}

async function seedAudit(state: InMemoryState, entries: readonly InMemorySeedAuditEntry[]): Promise<void> {
    for (const seedEntry of entries) {
        const previous = state.audit.at(-1);
        const seq = (previous?.seq ?? 0) + 1;
        const entry = AuditEntry.omit({ hash: true }).parse({
            ...seedEntry,
            id: `audit-${String(seq).padStart(6, '0')}`,
            seq,
            prevHash: previous?.hash ?? null,
        });
        state.audit.push({ ...entry, hash: await hashAuditEntry(entry) });
    }
}

function defaultSecurity(at: Timestamp): Unbranded<z.input<typeof SecurityOverview>> {
    const zeros = '0'.repeat(64);
    return {
        engine: { version: '1.0.0', releaseLogIndex: null },
        update: { status: 'none', policy: 'auto', pinnedVersion: null, availableVersion: null, eligibleAt: null },
        ui: { version: '1.0.0', bundleSha256: zeros, releaseLogIndex: null },
        tls: { certificateSha256: zeros, notAfter: at, lastCtCheck: null },
        relays: [],
        hostnames: [{ hostname: 'engine.localhost', kind: 'default' }],
        lastHeartbeat: null,
        outboundDestinations: [],
    };
}
