import type { z } from 'zod';

import { Agent, AgentRunState } from './agents';
import type { AgentVisibility } from './agents';
import { ApiToken } from './api-tokens';
import { AuditEntry } from './audit';
import type { AuditAction, AuditDetails, AuditTarget } from './audit';
import { Activity } from './capabilities/activity';
import { CapabilityRef, KNOWN_CAPABILITIES, supports } from './capabilities/capability';
import { FileMetadata, FileVersion } from './capabilities/files';
import type { FileScanStatus } from './capabilities/files';
import { Integration } from './capabilities/integrations';
import type { IntegrationStatus } from './capabilities/integrations';
import { RunDetail } from './capabilities/runs';
import type { Run, RunStatus } from './capabilities/runs';
import { Trigger, TriggerFire } from './capabilities/triggers';
import { Chat, Message } from './chats';
import type { ChatSource, MessageRole } from './chats';
import { createEngineApiClient, EngineApiContractError } from './client';
import type { EngineApiClient, EngineApiResponse, EngineApiTransport, EngineApiTransportRequest } from './client';
import {
    AgentId,
    AgentPermanentId,
    AuditEntryId,
    ChatId,
    ClientInfo,
    FolderId,
    MemberId,
    MessageId,
    OpaqueId,
    OrgId,
    RevisionId,
    SessionId,
    Timestamp,
} from './common';
import type { ProblemDetails } from './common';
import { MAX_AUDIT_TARGET_NAME_LENGTH } from './constants';
import { EngineInfo } from './engine';
import { EngineEvent } from './events';
import { Folder } from './folders';
import { hashAuditEntry } from './in-memory/audit-chain';
import { checkBook } from './in-memory/book';
import { HANDLERS } from './in-memory/handlers';
import type { HandlerContext } from './in-memory/handlers';
import { addFile, resolveUploadPolicies, setFileScan } from './in-memory/files';
import type { FileUploadPolicies, NewFile } from './in-memory/files';
import { setIntegrationStatus } from './in-memory/integrations';
import {
    addChatMessages,
    DEFAULT_ENGINE_CHECKS,
    EMPTY_CHAT_SUMMARY,
    liveAgent,
    recordActivity,
    summariseMessage,
} from './in-memory/kit';
import type {
    ActivityInput,
    Actor,
    ChatSummary,
    EngineChecks,
    EngineContext,
    ReplyProgress,
    ReplyScript,
    Sleep,
} from './in-memory/kit';
import {
    addProjectChange,
    advanceRun,
    findRuns,
    reportRunProgress,
    runDetailView,
    runSummary,
    startRun,
} from './in-memory/runs';
import type { RunOutcome, RunReport, StartRun } from './in-memory/runs';
import type { FileRecord, InMemoryState } from './in-memory/state';
import { findTriggers, fireTrigger } from './in-memory/triggers';
import type { FireInput } from './in-memory/triggers';
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

type RunDetailInput = Unbranded<z.input<typeof RunDetail>>;

/**
 * A run in contract shape, minus what the core derives: `agentName` comes from the agent and `outputs.fileNames` from
 * the seeded files; a missing `preview` is `null`.
 */
export type InMemorySeedRun = Omit<RunDetailInput, 'agentName' | 'preview' | 'outputs'> & {
    readonly agentName?: string | null;
    readonly preview?: string | null;
    readonly outputs: Omit<RunDetailInput['outputs'], 'fileNames'> & { readonly fileNames?: readonly string[] };
};

type TriggerInput = Unbranded<z.input<typeof Trigger>>;

/** A trigger in contract shape; `agentName` defaults to `null`, and the core reads the agent's current name on every answer. */
export type InMemorySeedTrigger = TriggerInput extends infer Each
    ? Each extends TriggerInput
        ? Omit<Each, 'agentName'> & { readonly agentName?: string | null }
        : never
    : never;

export type InMemorySeedActivity =
    Unbranded<z.input<typeof Activity>> extends infer Each
        ? Each extends Unbranded<z.input<typeof Activity>>
            ? Omit<Each, 'agentName'> & { readonly agentName?: string | null }
            : never
        : never;

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
    readonly chats?: readonly InMemorySeedChat[];
    readonly messages?: readonly Unbranded<z.input<typeof Message>>[];
    readonly secrets?: readonly Unbranded<z.input<typeof SecretMetadata>>[];
    readonly apiTokens?: readonly Unbranded<z.input<typeof ApiToken>>[];
    readonly passkeys?: readonly Unbranded<z.input<typeof Passkey>>[];
    readonly sessions?: readonly Unbranded<z.input<typeof Session>>[];
    readonly files?: readonly InMemorySeedFile[];
    readonly runs?: readonly InMemorySeedRun[];
    readonly triggers?: readonly {
        readonly trigger: InMemorySeedTrigger;
        /** Oldest first. */
        readonly fires?: readonly Unbranded<z.input<typeof TriggerFire>>[];
    }[];
    readonly integrations?: readonly Unbranded<z.input<typeof Integration>>[];
    /** Oldest first; `agentName` defaults to `null`, and reads answer the agent's current name. */
    readonly activity?: readonly InMemorySeedActivity[];
    readonly auditEntries?: readonly InMemorySeedAuditEntry[];
}

/** The summary (`messageCount`, `lastMessageAt`, `preview`) is derived from the seed's messages; `source` defaults to `web`. */
export type InMemorySeedChat = Omit<
    Unbranded<z.input<typeof Chat>>,
    'source' | 'messageCount' | 'lastMessageAt' | 'preview'
> & { readonly source?: ChatSource };

/**
 * A chat no member started: by default a public visitor of a public agent (`web`); `api` for an API client. Its
 * messages (oldest first) are all `completed`, and its user messages have no member either.
 */
export interface InMemoryVisitorChat {
    readonly agentId: string;
    readonly source?: ChatSource;
    readonly title?: string;
    readonly messages?: readonly { readonly role: MessageRole; readonly content: string }[];
}

/** `versions` (oldest first) default to one version with `content`; `versionCount` is derived from them. */
export interface InMemorySeedFile {
    readonly metadata: Omit<Unbranded<z.input<typeof FileMetadata>>, 'versionCount'>;
    readonly content: Blob;
    readonly versions?: readonly { readonly version: Unbranded<z.input<typeof FileVersion>>; readonly content: Blob }[];
}

/** What a core is built from. Who acts is not an option: every request names its {@link Actor}. */
export interface InMemoryEngineCoreOptions {
    readonly seed?: InMemorySeed;
    readonly clock?: Clock;
    /** The member the seed's defaults belong to (one passkey and one session); added if the seed lacks them. */
    readonly member?: Omit<InMemoryMember, 'permissions'>;
    readonly replyScript?: ReplyScript;
    /** What `GET /engine` advertises; routes of any other capability answer 404 `capability-not-supported`. */
    readonly capabilities?: readonly Unbranded<CapabilityRef>[];
    /** Runs for every route with a permission; the default allows exactly the actor's permissions. */
    readonly authorizer?: Authorizer;
    /** How many events `GET /events` can replay after a reconnect (default 1,000). */
    readonly eventBufferSize?: number;
    /** Paces scripted replies; defaults to a timer. */
    readonly sleep?: Sleep;
    /** The virus scan and connection test a real engine runs; by default files are clean and connections work. */
    readonly checks?: Partial<EngineChecks>;
    /** Upload limits per purpose (`GET /files/upload-policy`); by default any type up to `MAX_FILE_BYTES`. */
    readonly uploadPolicies?: FileUploadPolicies;
}

export interface InMemoryEngineApiOptions extends InMemoryEngineCoreOptions {
    readonly member?: InMemoryMember;
    /** `required` makes every `stepUp` route answer 401 `step-up-required`, as the gateway does without a fresh assertion. */
    readonly stepUp?: 'satisfied' | 'required';
    /** Recorded in audit entries as the request's origin. */
    readonly client?: Unbranded<z.input<typeof ClientInfo>>;
}

export const RESOURCE_KINDS = [
    'agent',
    'revision',
    'folder',
    'chat',
    'message',
    'member',
    'invite',
    'api-token',
    'passkey',
    'session',
    'secret',
    'file',
    'run',
    'trigger',
    'integration',
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/**
 * The one resource a route acts on, from its last path parameter. `createdBy` is the member who owns it (for passkeys
 * and sessions, the member they belong to); it is absent when the resource has no owner or does not exist, in which
 * case the route answers 404 itself.
 */
export interface AuthorizationResource {
    readonly kind: ResourceKind;
    readonly id: string;
    readonly createdBy?: MemberId | null;
}

export type AuthorizationDecision = { readonly kind: 'allow' } | { readonly kind: 'deny'; readonly reason: string };

/**
 * The engine's policy port (ADR 0006), asked before every route that declares a permission. A denial answers like a
 * missing permission: 403 `forbidden` with the route's `requiredPermission`, audited as `denied`. Lists and events are
 * filtered by permission only.
 */
export interface Authorizer {
    can(actor: Actor, permission: Permission, resource: AuthorizationResource | null): AuthorizationDecision;
}

export const PERMISSION_AUTHORIZER: Authorizer = {
    can: (actor, permission) =>
        actor.permissions.has(permission) ? { kind: 'allow' } : { kind: 'deny', reason: 'missing-permission' },
};

/** Counts and members for an engine's own reporting, read without a request and without an audit entry. */
export interface InMemoryEngineSnapshot {
    readonly counts: Readonly<
        Record<
            | 'members'
            | 'agents'
            | 'folders'
            | 'chats'
            | 'messages'
            | 'secrets'
            | 'apiTokens'
            | 'passkeys'
            | 'sessions'
            | 'files'
            | 'runs'
            | 'triggers'
            | 'integrations'
            | 'activity'
            | 'auditEntries',
            number
        >
    >;
    readonly members: readonly Member[];
    readonly passkeys: readonly Passkey[];
    /** As stored: `current` is always `false` here, since no request is making them current. */
    readonly sessions: readonly Session[];
}

/**
 * Levers for what the engine does on its own, outside any request: runs progressing, schedules coming due, the
 * gateway signing members in and out, the process reporting its relays. Timestamps come from the injected clock, and
 * levers write no audit entries; only requests are audited.
 */
export interface InMemoryEngineController {
    /** Appends to the activity feed (stamped with an ID and the clock) and announces it on the event stream. */
    appendActivity(activity: Unbranded<ActivityInput>): Activity;
    /** Starts a queued run, or ends a running one with `outcome` (default `completed`; `cancelled` if requested). */
    advanceRun(runId: string, outcome?: Unbranded<RunOutcome>): Run;
    /** A schedule comes due, or an email arrives for an email trigger (with its subject, for the run's preview). */
    fireTrigger(triggerId: string, input?: FireInput): TriggerFire;
    /** Sends an event as is, e.g. a change made by another member. */
    emit(event: Unbranded<z.input<typeof EngineEvent>>): void;
    /** Queues a run outside a chat turn or a trigger (an API client, a member, a goal); announced as `run.queued`. */
    startRun(run: StartRun): Run;
    /** A runner's report on a queued or running run: its progress card, a tool call (by `id`), model and runner. */
    reportRunProgress(runId: string, report: RunReport): Run;
    /** A commit the run made, listed in its outputs; a diff over `MAX_RUN_TEXT_BYTES` is truncated and flagged. */
    addProjectChange(runId: string, change: unknown): Run;
    /** A file the engine stores itself, such as a run's output; announced as `file.created`. */
    addFile(file: NewFile): Promise<FileMetadata>;
    /** A scan result arrived; `failed` is announced as `file.scan-failed`. */
    setFileScan(fileId: string, status: FileScanStatus): FileMetadata;
    /** The engine noticed a connection change; announced as `integration.connected` or `integration.error`. */
    setIntegrationStatus(
        integrationId: string,
        status: { readonly status: IntegrationStatus; readonly statusDetail?: string | null },
    ): Integration;
    getRun(runId: string): RunDetail | undefined;
    findRuns(filter?: { readonly status?: readonly RunStatus[] }): readonly Run[];
    getTrigger(triggerId: string): Trigger | undefined;
    findTriggers(filter?: {
        readonly kind?: Trigger['kind'];
        readonly lifecycle?: Trigger['lifecycle'];
    }): readonly Trigger[];
    /** Agents that are not deleted. */
    findAgents(): readonly Agent[];
    /** Every event as it is published, before any member's filter; the returned function unsubscribes. */
    onEvent(listener: (event: EngineEvent) => void): () => void;
    /** E.g. the dashboard URL once the engine is linked. `capabilities` come from the core's options. */
    updateEngine(patch: Partial<Omit<Unbranded<z.input<typeof EngineInfo>>, 'capabilities'>>): EngineInfo;
    /** E.g. each relay's link state. */
    updateSecurity(patch: Partial<Unbranded<z.input<typeof SecurityOverview>>>): SecurityOverview;
    /** Throws for an unknown or deleted agent. Announced with `chat.changed`, like a chat a member starts. */
    addVisitorChat(chat: InMemoryVisitorChat): Chat;
    /** Throws if the ID is taken. */
    addMember(member: Unbranded<z.input<typeof Member>>): Member;
    /** A sign-in; throws for an unknown member or a taken ID. `current` is decided per request. */
    addSession(session: Omit<Unbranded<z.input<typeof Session>>, 'current'>): Session;
    /** A sign-out or expiry; `false` if the session was not listed. */
    removeSession(sessionId: string): boolean;
    inspect(): InMemoryEngineSnapshot;
}

export interface InMemoryEngine {
    readonly client: EngineApiClient;
    readonly controller: InMemoryEngineController;
}

/** One engine, many members: each request runs as the actor its transport was made for. */
export interface InMemoryEngineCore {
    /** Resolves with exactly what an engine would send (strictly checked), so it can be served over HTTP. */
    transport(actor: Actor): EngineApiTransport;
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

/** The in-memory client, acting as one member, together with the core's controller. */
export function createInMemoryEngine(options: InMemoryEngineApiOptions = {}): InMemoryEngine {
    const core = createInMemoryEngineCore(options);
    const client = createEngineApiClient(
        withUploadProgress(withClientReading(core.transport(actorFromOptions(options)))),
    );
    return {
        client: Object.defineProperty(client, Symbol.toStringTag, { value: IN_MEMORY_CLIENT_MARKER }),
        controller: core.controller,
    };
}

/** Nothing is on a wire here: an upload that asks for progress hears of none until the engine accepts it. */
function withUploadProgress(transport: EngineApiTransport): EngineApiTransport {
    return async (route, request, signal) => {
        const { onUploadProgress, ...rest } = request;
        const result = await transport(route, rest, signal);
        if (onUploadProgress !== undefined && result.kind === 'ok') {
            const size = multipartSize(request.body);
            onUploadProgress({ loadedBytes: size, totalBytes: size });
        }
        return result;
    };
}

/** The parts' sizes; the in-memory engine encodes no multipart body, so there is no boundary overhead to count. */
function multipartSize(body: unknown): number {
    if (typeof body !== 'object' || body === null) return 0;
    let size = 0;
    for (const value of Object.values(body)) {
        if (value instanceof Blob) size += value.size;
        else if (typeof value === 'string') size += new TextEncoder().encode(value).byteLength;
    }
    return size;
}

const DEFAULT_MEMBER_ID = 'member-owner';
const DEFAULT_SESSION_ID = 'session-current';
const DEFAULT_PASSKEY_ID = 'passkey-owner';

/** The member the options describe, signed in on the seed's current session for them. */
export function actorFromOptions(options: InMemoryEngineApiOptions): Actor {
    const memberId = options.member?.id ?? DEFAULT_MEMBER_ID;
    const current = options.seed?.sessions?.find((session) => session.memberId === memberId && session.current);
    return {
        memberId: MemberId.parse(memberId),
        sessionId: SessionId.parse(current?.id ?? DEFAULT_SESSION_ID),
        client: ClientInfo.parse(options.client ?? { ip: '127.0.0.1', userAgent: 'in-memory engine API client' }),
        permissions: new Set(options.member?.permissions ?? OWNER_PERMISSIONS),
        stepUpFresh: options.stepUp !== 'required',
    };
}

const DEFAULT_REPLY_SCRIPT: ReplyScript = ({ agent, content }) => ({
    chunks: `${agent.name} received: ${content}`.split(/(?<= )/),
});

export const DEFAULT_EVENT_BUFFER_SIZE = 1_000;

const timerSleep: Sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason as Error);
            return;
        }
        const abort = (): void => {
            clearTimeout(timer);
            reject(signal.reason as Error);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve();
        }, ms);
        signal.addEventListener('abort', abort, { once: true });
    });

/** Resolves when `ready()` holds after a `wake`, rejects when `signal` aborts. */
function waitFor(waiters: Set<() => void>, ready: () => boolean, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (ready()) {
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
}

/** The in-memory engine as a server sees it: one shared state, a transport per request's actor, and its levers. */
export function createInMemoryEngineCore(options: InMemoryEngineCoreOptions = {}): InMemoryEngineCore {
    const clock = options.clock ?? { now: () => new Date() };
    const now = (): Timestamp => Timestamp.parse(clock.now().toISOString());
    const authorizer = options.authorizer ?? PERMISSION_AUTHORIZER;
    const eventBufferSize = options.eventBufferSize ?? DEFAULT_EVENT_BUFFER_SIZE;
    if (!Number.isSafeInteger(eventBufferSize) || eventBufferSize < 1) {
        throw new RangeError('eventBufferSize must be a positive integer');
    }
    const seedMember = Member.parse({
        id: options.member?.id ?? DEFAULT_MEMBER_ID,
        displayName: options.member?.displayName ?? 'Owner',
        role: options.member?.role ?? 'owner',
        status: 'active',
        createdAt: now(),
        lastSeenAt: now(),
    });
    const capabilities = (options.capabilities ?? Object.values(KNOWN_CAPABILITIES)).map((ref) =>
        CapabilityRef.parse(ref),
    );
    const state = createState(options.seed ?? {}, seedMember, now, capabilities, options.uploadPolicies);
    const counters = new Map<string, number>();
    const eventWaiters = new Set<() => void>();
    const eventListeners = new Set<(event: EngineEvent) => void>();
    const replyWaiters = new Map<string, Set<() => void>>();
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
        state.eventSeq++;
        state.events.push({ id: String(state.eventSeq), seq: state.eventSeq, event });
        if (state.events.length > eventBufferSize) state.events.splice(0, state.events.length - eventBufferSize);
        for (const wake of [...eventWaiters]) wake();
        for (const listener of [...eventListeners]) listener(event);
    };
    const nextEvent: HandlerContext['nextEvent'] = (afterSeq, signal) =>
        waitFor(eventWaiters, () => state.eventSeq > afterSeq, signal);
    const replies: ReplyProgress = {
        sleep: options.sleep ?? timerSleep,
        notify: (messageId) => {
            for (const wake of [...(replyWaiters.get(messageId) ?? [])]) wake();
        },
        next: (messageId, signal) => {
            let waiters = replyWaiters.get(messageId);
            if (!waiters) {
                waiters = new Set();
                replyWaiters.set(messageId, waiters);
            }
            const settled = waitFor(waiters, () => false, signal);
            const forget = (): void => {
                if (waiters.size === 0) replyWaiters.delete(messageId);
            };
            settled.then(forget, forget);
            return settled;
        },
    };
    const audit = (
        actor: Actor,
        action: AuditAction,
        target: AuditEntry['target'],
        outcome: AuditEntry['outcome'],
        details: AuditDetails | null,
    ): void => {
        const at = now();
        auditTail = auditTail.then(async () => {
            const previous = state.audit.at(-1);
            const seq = (previous?.seq ?? 0) + 1;
            const entry = {
                id: AuditEntryId.parse(`audit-${String(seq).padStart(6, '0')}`),
                seq,
                at,
                actor: { kind: 'member' as const, memberId: actor.memberId },
                action,
                target,
                outcome,
                client: actor.client,
                details,
                prevHash: previous?.hash ?? null,
            };
            state.audit.push({ ...entry, hash: await hashAuditEntry(entry) });
        });
    };

    const checks: EngineChecks = { ...DEFAULT_ENGINE_CHECKS, ...options.checks };
    const system: EngineContext = { state, checks, now, newId, publish, replies };
    const controller: InMemoryEngineController = {
        appendActivity: (activity) => recordActivity(system, activity as ActivityInput),
        advanceRun: (runId, outcome) => advanceRun(system, runId, outcome),
        fireTrigger: (triggerId, input) => fireTrigger(system, triggerId, input),
        emit: (event) => {
            publish(EngineEvent.parse(event));
        },
        startRun: (run) => startRun(system, run),
        reportRunProgress: (runId, report) => reportRunProgress(system, runId, report),
        addProjectChange: (runId, change) => addProjectChange(system, runId, change),
        addFile: (file) => addFile(system, file),
        setFileScan: (fileId, status) => setFileScan(system, fileId, status),
        setIntegrationStatus: (integrationId, status) => setIntegrationStatus(system, integrationId, status),
        getRun: (runId) => {
            const detail = state.runs.get(runId);
            return detail === undefined ? undefined : runDetailView(system, detail);
        },
        findRuns: (filter = {}) => findRuns(system, filter).map((run) => runSummary(system, run)),
        getTrigger: (triggerId) => state.triggers.get(triggerId)?.trigger,
        findTriggers: (filter = {}) => findTriggers(system, filter),
        findAgents: () =>
            [...state.agents.values()].map(({ agent }) => agent).filter(({ deletedAt }) => deletedAt === null),
        onEvent: (listener) => {
            eventListeners.add(listener);
            return () => {
                eventListeners.delete(listener);
            };
        },
        updateEngine: (patch) => {
            state.engine = EngineInfo.parse({ ...state.engine, ...patch, capabilities: state.engine.capabilities });
            return state.engine;
        },
        updateSecurity: (patch) => {
            state.security = SecurityOverview.parse({ ...state.security, ...patch });
            return state.security;
        },
        addVisitorChat: (input) => {
            const agent = liveAgent(system, input.agentId);
            if (agent.kind === 'problem') throw new Error(`cannot add a chat: ${agent.problem.code}`);
            const at = now();
            const chat = Chat.parse({
                id: newId(ChatId, 'chat'),
                agentId: agent.data.id,
                title: input.title ?? '',
                source: input.source ?? 'web',
                createdBy: null,
                createdAt: at,
                updatedAt: at,
                ...EMPTY_CHAT_SUMMARY,
            });
            state.chats.set(chat.id, chat);
            const messages = (input.messages ?? []).map((message) =>
                Message.parse({
                    id: newId(MessageId, 'message'),
                    chatId: chat.id,
                    role: message.role,
                    content: message.content,
                    status: 'completed',
                    createdBy: null,
                    createdAt: now(),
                }),
            );
            return addChatMessages(system, chat, messages);
        },
        addMember: (input) => {
            const member = Member.parse(input);
            if (state.members.has(member.id)) throw new Error('member ID already taken');
            state.members.set(member.id, member);
            return member;
        },
        addSession: (input) => {
            const session = Session.parse({ ...input, current: false });
            if (!state.members.has(session.memberId)) throw new Error('session for an unknown member');
            if (state.sessions.has(session.id)) throw new Error('session ID already taken');
            if (session.passkeyId !== null && state.passkeys.get(session.passkeyId)?.memberId !== session.memberId) {
                throw new Error("session signed in with a passkey that is not the member's");
            }
            state.sessions.set(session.id, session);
            return session;
        },
        removeSession: (sessionId) => state.sessions.delete(sessionId),
        inspect: () => ({
            counts: {
                members: state.members.size,
                agents: state.agents.size,
                folders: state.folders.size,
                chats: state.chats.size,
                messages: state.messages.size,
                secrets: state.secrets.size,
                apiTokens: state.apiTokens.size,
                passkeys: state.passkeys.size,
                sessions: state.sessions.size,
                files: state.files.size,
                runs: state.runs.size,
                triggers: state.triggers.size,
                integrations: state.integrations.size,
                activity: state.activity.length,
                auditEntries: state.audit.length,
            },
            members: [...state.members.values()],
            passkeys: [...state.passkeys.values()],
            sessions: [...state.sessions.values()].map((session) => ({ ...session, current: false })),
        }),
    };

    const transport =
        (actor: Actor): EngineApiTransport =>
        async (route, request, signal) => {
            signal.throwIfAborted();
            await auditTail;
            // An engine without the capability has no such route, whoever asks.
            if (route.capability && !supports(state.engine, route.capability)) {
                return { kind: 'problem', problem: createProblem('capability-not-supported') };
            }
            // Read on every request, so a removed member is signed out and a changed role applies at once.
            const member = state.members.get(actor.memberId);
            if (!member) return { kind: 'problem', problem: createProblem('unauthenticated') };
            const routeId = route.id as EngineApiRouteId;
            const audited = AUDITED[routeId];
            // Taken before the handler runs, so a deleted or renamed target is logged under the name it had.
            const targetBefore = audited ? auditTarget(state, audited, request.params, undefined) : null;
            const deny = (problem: ProblemDetails): EngineApiResponse<never> => {
                if (audited) audit(actor, audited.action, targetBefore, 'denied', problemDetails(problem));
                return { kind: 'problem', problem };
            };
            if (route.permission !== null) {
                const decision = authorizer.can(actor, route.permission, resourceOf(state, route, request.params));
                if (decision.kind === 'deny') {
                    return deny(createProblem('forbidden', { requiredPermission: route.permission }));
                }
            }
            if (route.stepUp && !actor.stepUpFresh) return deny(createProblem('step-up-required'));
            const parsed = parseRequest(route, request);
            if (parsed.kind === 'problem') {
                if (audited) audit(actor, audited.action, targetBefore, 'failed', problemDetails(parsed.problem));
                return parsed;
            }
            const handler = HANDLERS[routeId] as (
                request: ParsedRouteRequest<RouteDefinition>,
                ctx: HandlerContext,
            ) => ReturnType<(typeof HANDLERS)[EngineApiRouteId]>;
            const result = await handler(parsed.request, {
                ...system,
                member,
                actor,
                permissions: actor.permissions,
                nextEvent,
                replyScript: options.replyScript ?? DEFAULT_REPLY_SCRIPT,
                signal,
            });
            if (audited) {
                if (result.kind === 'ok') {
                    const target = auditTarget(state, audited, parsed.request.params, result.data);
                    const named = target && { ...target, name: target.name ?? targetBefore?.name ?? null };
                    audit(actor, audited.action, named, 'success', bodyFieldDetails(parsed.request.body));
                } else {
                    audit(actor, audited.action, targetBefore, 'failed', problemDetails(result.problem));
                }
            }
            if (result.kind === 'problem') return result;
            return { kind: 'ok', data: checkSuccess(route, result.data) };
        };
    return { transport, controller };
}

const PARAM_RESOURCES: Readonly<Record<string, ResourceKind>> = {
    agentId: 'agent',
    revisionId: 'revision',
    folderId: 'folder',
    chatId: 'chat',
    messageId: 'message',
    memberId: 'member',
    inviteId: 'invite',
    apiTokenId: 'api-token',
    passkeyId: 'passkey',
    sessionId: 'session',
    secretId: 'secret',
    fileId: 'file',
    runId: 'run',
    triggerId: 'trigger',
    integrationId: 'integration',
};

/** The resource named by the route's last path parameter, before the input is parsed (so a bad ID stays a 400). */
function resourceOf(
    state: InMemoryState,
    route: RouteDefinition,
    params: EngineApiTransportRequest['params'],
): AuthorizationResource | null {
    const name = [...route.path.matchAll(/\{(\w+)\}/g)].at(-1)?.[1];
    const kind = name === undefined ? undefined : PARAM_RESOURCES[name];
    const id = name === undefined ? undefined : params?.[name];
    if (kind === undefined || typeof id !== 'string') return null;
    const createdBy = ownerOf(state, kind, id, params);
    return createdBy === undefined ? { kind, id } : { kind, id, createdBy };
}

function ownerOf(
    state: InMemoryState,
    kind: ResourceKind,
    id: string,
    params: EngineApiTransportRequest['params'],
): MemberId | null | undefined {
    switch (kind) {
        case 'agent':
            return state.agents.get(id)?.agent.createdBy;
        case 'revision': {
            const agentId = params?.['agentId'];
            const agent = typeof agentId === 'string' ? state.agents.get(agentId) : undefined;
            return agent?.revisions.find((revision) => revision.id === id)?.createdBy;
        }
        case 'chat':
            return state.chats.get(id)?.createdBy;
        case 'message':
            return state.messages.get(id)?.createdBy;
        case 'invite':
            return state.invites.get(id)?.createdBy;
        case 'api-token':
            return state.apiTokens.get(id)?.createdBy;
        case 'passkey':
            return state.passkeys.get(id)?.memberId;
        case 'session':
            return state.sessions.get(id)?.memberId;
        case 'secret':
            return state.secrets.get(id)?.createdBy;
        case 'file':
            return state.files.get(id)?.metadata.createdBy;
        case 'run':
            return state.runs.get(id)?.createdBy;
        case 'trigger':
            return state.triggers.get(id)?.trigger.createdBy;
        case 'integration':
            return state.integrations.get(id)?.createdBy;
        case 'folder':
        case 'member':
            return undefined;
    }
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

function auditTarget(state: InMemoryState, rule: AuditRule, params: unknown, created: unknown): AuditTarget | null {
    if (rule.kind === null) return null;
    const id =
        rule.param === undefined ? createdId(created) : (params as Record<string, unknown> | undefined)?.[rule.param];
    const parsed = OpaqueId.safeParse(id);
    if (!parsed.success) return null;
    const name = targetName(state, rule.kind, parsed.data);
    return { kind: rule.kind, id: parsed.data, name: name?.slice(0, MAX_AUDIT_TARGET_NAME_LENGTH) || null };
}

/** The name a member would recognise the target by, as the engine holds it now; `undefined` once it is gone. */
function targetName(state: InMemoryState, kind: AuditTarget['kind'], id: string): string | null | undefined {
    switch (kind) {
        case 'agent':
            return state.agents.get(id)?.agent.name;
        case 'folder':
            return state.folders.get(id)?.name;
        case 'chat':
            return state.chats.get(id)?.title;
        case 'member':
            return state.members.get(id)?.displayName;
        case 'api-token':
            return state.apiTokens.get(id)?.name;
        case 'secret':
            return state.secrets.get(id)?.name;
        case 'file':
            return state.files.get(id)?.metadata.name;
        case 'passkey':
            return state.passkeys.get(id)?.name;
        case 'trigger':
            return state.triggers.get(id)?.trigger.name;
        case 'integration':
            return state.integrations.get(id)?.name;
        case 'message':
        case 'invite':
        case 'session':
        case 'settings':
        case 'engine':
        case 'run':
            return null;
    }
}

/** Why a request was refused: the problem's code and, for a missing permission, which one. Never its detail text. */
function problemDetails(problem: ProblemDetails): AuditDetails {
    const required = (problem as Readonly<Record<string, unknown>>)['requiredPermission'];
    return typeof required === 'string'
        ? { problem: problem.code, requiredPermission: required }
        : { problem: problem.code };
}

/** Which fields a successful request set, by name only: values can be secrets or content. */
function bodyFieldDetails(body: unknown): AuditDetails | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body) || body instanceof FormData) return null;
    const fields = Object.keys(body).sort();
    return fields.length === 0 ? null : { fields };
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

/** Agents are seeded later, so `agentName` stays as given here; the core reads the current name on every answer. */
function seedRun(record: InMemorySeedRun, files: ReadonlyMap<string, FileRecord>): RunDetail {
    const fileNames =
        record.outputs.fileNames ??
        record.outputs.files.map((fileId) => {
            const file = files.get(fileId);
            if (file === undefined) throw new Error(`Seeded run ${record.id} lists unknown output file ${fileId}`);
            return file.metadata.name;
        });
    return RunDetail.parse({
        ...record,
        agentName: record.agentName ?? null,
        preview: record.preview ?? null,
        outputs: { ...record.outputs, fileNames },
    });
}

function createState(
    seed: InMemorySeed,
    member: Member,
    now: () => Timestamp,
    capabilities: readonly CapabilityRef[],
    uploadPolicies: FileUploadPolicies | undefined,
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
    const files = new Map((seed.files ?? []).map(seedFile));
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
        chats: new Map(),
        messages: byId((seed.messages ?? []).map((record) => Message.parse(record))),
        replies: new Map(),
        secrets: byId(
            (seed.secrets ?? []).map((record) => SecretMetadata.parse({ valueUpdatedAt: record.createdAt, ...record })),
        ),
        apiTokens: byId((seed.apiTokens ?? []).map((record) => ApiToken.parse(record))),
        passkeys: byId(
            (
                seed.passkeys ?? [
                    {
                        id: DEFAULT_PASSKEY_ID,
                        memberId: member.id,
                        name: 'This device',
                        createdAt: at,
                        lastUsedAt: at,
                        authenticator: { attachment: 'platform', backedUp: true },
                    },
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
                        passkeyId: seed.passkeys === undefined ? DEFAULT_PASSKEY_ID : null,
                        createdAt: at,
                        lastSeenAt: at,
                        expiresAt: Timestamp.parse(new Date(Date.parse(at) + 12 * 3_600_000).toISOString()),
                    },
                ]
            ).map((record) => Session.parse(record)),
        ),
        files,
        uploadPolicies: resolveUploadPolicies(uploadPolicies),
        runs: byId((seed.runs ?? []).map((record) => seedRun(record, files))),
        triggers: new Map(
            (seed.triggers ?? []).map(({ trigger, fires }) => {
                const parsed = Trigger.parse({ ...trigger, agentName: trigger.agentName ?? null });
                return [parsed.id, { trigger: parsed, fires: (fires ?? []).map((fire) => TriggerFire.parse(fire)) }];
            }),
        ),
        integrations: byId((seed.integrations ?? []).map((record) => Integration.parse(record))),
        activity: (seed.activity ?? []).map((record) =>
            Activity.parse({ ...record, agentName: record.agentName ?? null }),
        ),
        audit: [],
        events: [],
        eventSeq: 0,
    };
    const summaries = summariseSeedMessages(state.messages.values());
    for (const record of seed.chats ?? []) {
        const chat = Chat.parse({ source: 'web', ...record, ...(summaries.get(record.id) ?? EMPTY_CHAT_SUMMARY) });
        state.chats.set(chat.id, chat);
    }
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

function summariseSeedMessages(messages: Iterable<Message>): Map<string, ChatSummary> {
    const oldestFirst = [...messages].sort(
        (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
    );
    const summaries = new Map<string, ChatSummary>();
    for (const message of oldestFirst) {
        summaries.set(message.chatId, summariseMessage(summaries.get(message.chatId) ?? EMPTY_CHAT_SUMMARY, message));
    }
    return summaries;
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

/** Fixed, recognisable placeholders rather than real hashes or log entries, so nobody mistakes them for evidence. */
function defaultSecurity(at: Timestamp): Unbranded<z.input<typeof SecurityOverview>> {
    const zeros = '0'.repeat(64);
    return {
        engine: { version: '1.0.0', releaseLogIndex: 1, releaseLogEntryUuid: '1'.repeat(64) },
        update: { status: 'none', policy: 'auto', pinnedVersion: null, availableVersion: null, eligibleAt: null },
        ui: {
            version: '1.0.0',
            bundleSha256: zeros,
            releaseLogIndex: 2,
            releaseLogEntryUuid: '2'.repeat(64),
            lastUpdateCheck: { at, outcome: 'up-to-date', version: '1.0.0', reason: null, revocationReason: null },
        },
        tls: { certificateSha256: zeros, notAfter: at, lastCtCheck: { at, result: 'ok', unexpectedCertificates: [] } },
        relays: [],
        hostnames: [
            { hostname: 'engine.localhost', kind: 'default', certificateStatus: 'valid', claimRegistered: null },
        ],
        lastHeartbeat: null,
        clockSkew: null,
        outboundDestinations: [],
    };
}
