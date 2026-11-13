import type { z } from 'zod';

import type { Agent } from '../agents';
import { Activity } from '../capabilities/activity';
import type { ActivityActor } from '../capabilities/activity';
import { supports } from '../capabilities/capability';
import type { CapabilityRef } from '../capabilities/capability';
import type { FilePurpose, FileScanStatus } from '../capabilities/files';
import type { Integration } from '../capabilities/integrations';
import { ActivityId } from '../common';
import type { AgentId, ChatId, ClientInfo, MemberId, ProblemDetails, SessionId, Timestamp } from '../common';
import type { EngineEvent } from '../events';
import type { Member } from '../members';
import type { Permission } from '../permissions';
import { createProblem } from '../problem';
import type { ProblemExtras } from '../problem';
import type { ProblemCode } from '../problem-codes';
import type { ParsedRouteRequest, RouteEngineData } from '../route';
import type { ENGINE_API_ROUTES, EngineApiRouteId } from '../routes';
import { paginate } from './paging';
import type { SortSpec, SortValue } from './paging';
import type { InMemoryState } from './state';
import type { StepInput } from './turns';

export type HandlerResult<T> =
    { readonly kind: 'ok'; readonly data: T } | { readonly kind: 'problem'; readonly problem: ProblemDetails };

/** One piece of a scripted reply; `delayMs` is how long the engine "thinks" before producing it. */
export interface ReplyChunk {
    readonly text: string;
    readonly delayMs?: number;
}

/** One thing the agent does before it writes; `delayMs` is how long it takes. */
export interface ScriptedStep extends StepInput {
    readonly delayMs?: number;
}

export interface ScriptedReply {
    /**
     * What the agent does before it writes, saved as a `progress` message ahead of the `final` reply. With a delay on
     * any step the turn is paced like a paced reply: the thread shows the agent working through them as they happen.
     */
    readonly steps?: readonly ScriptedStep[];
    /**
     * A reply whose chunks carry no `delayMs` generates as it is streamed, as in C-04's in-memory client. With a delay
     * on any chunk it is paced: it generates on its own from the moment it is sent, whether or not anyone reads it,
     * and only the cancel route stops it.
     */
    readonly chunks: readonly (string | ReplyChunk)[];
    /** `failed` ends the stream with `reply-failed` after the chunks. */
    readonly outcome?: 'completed' | 'failed';
}

export interface ReplyScriptInput {
    readonly agent: Agent;
    readonly content: string;
    /** `null` for a test conversation (`test-chat@1`), which belongs to no chat; `agent` then carries the draft's name and profile. */
    readonly chatId: ChatId | null;
    /** How many messages the chat held before this exchange, so a script can vary per turn deterministically. */
    readonly messageIndex: number;
}

export type ReplyScript = (input: ReplyScriptInput) => ScriptedReply;

/** Resolves after `ms`, rejects when `signal` aborts first. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** Who makes a request, as the engine's gateway resolved it. The engine API decides everything from this. */
export interface Actor {
    readonly memberId: MemberId;
    /** The session making the request; it is the one listed as `current`. */
    readonly sessionId: SessionId;
    /** Recorded in audit entries. */
    readonly client: ClientInfo;
    readonly permissions: ReadonlySet<Permission>;
    /** Whether the member confirmed with a fresh passkey assertion recently enough for `stepUp` routes. */
    readonly stepUpFresh: boolean;
}

/** Waits for paced replies to produce something new. */
export interface ReplyProgress {
    readonly sleep: Sleep;
    notify(messageId: string): void;
    /** Resolves on the next progress of `messageId` (a chunk or the end), rejects when `signal` aborts. */
    next(messageId: string, signal: AbortSignal): Promise<void>;
}

/** What a new file looks like to the engine's scanner; never its content. */
export interface ScannedFile {
    readonly name: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly purpose: FilePurpose;
}

export type IntegrationProbe =
    { readonly status: 'connected' } | { readonly status: 'error' | 'needs-attention'; readonly statusDetail: string };

/**
 * What a real engine finds out from the outside world and the in-memory engine cannot: a virus scan and a connection
 * test. An engine built on the core (the mock engine) supplies its own; by default every file is clean and every
 * integration whose secrets resolve is connected.
 */
export interface EngineChecks {
    scanFile(file: ScannedFile): FileScanStatus;
    /** Asked only once every secret the integration references resolves. */
    probeIntegration(integration: Integration): IntegrationProbe;
}

export const DEFAULT_ENGINE_CHECKS: EngineChecks = {
    scanFile: () => 'clean',
    probeIntegration: () => ({ status: 'connected' }),
};

/** What the engine itself needs to act, with or without a member request (the controller acts as the system). */
export interface EngineContext {
    readonly state: InMemoryState;
    readonly checks: EngineChecks;
    readonly now: () => Timestamp;
    readonly newId: <Schema extends z.ZodType<string, string>>(schema: Schema, prefix: string) => z.output<Schema>;
    readonly publish: (event: EngineEvent) => void;
    readonly replies: ReplyProgress;
}

export interface HandlerContext extends EngineContext {
    readonly member: Member;
    readonly actor: Actor;
    readonly permissions: ReadonlySet<Permission>;
    /** Resolves once an event with a sequence number above `afterSeq` exists, rejects when `signal` aborts. */
    readonly nextEvent: (afterSeq: number, signal: AbortSignal) => Promise<void>;
    readonly replyScript: ReplyScript;
    readonly signal: AbortSignal;
}

type Routes = typeof ENGINE_API_ROUTES;
export type Handler<Route> = (
    request: ParsedRouteRequest<Route>,
    ctx: HandlerContext,
) => HandlerResult<RouteEngineData<Route>> | Promise<HandlerResult<RouteEngineData<Route>>>;
export type Handlers = { readonly [Id in EngineApiRouteId]: Handler<Routes[Id]> };

export const ok = <T>(data: T): HandlerResult<T> => ({ kind: 'ok', data });
export const fail = (code: ProblemCode, extras?: ProblemExtras): HandlerResult<never> => ({
    kind: 'problem',
    problem: createProblem(code, extras),
});
export const notFound = (what: string): HandlerResult<never> => fail('not-found', { detail: `No such ${what}.` });
export const invalid = (path: string, message: string): HandlerResult<never> =>
    fail('validation-failed', { errors: [{ path, message }] });

export function page<T>(
    items: Iterable<T>,
    spec: SortSpec<T>,
    query: { readonly cursor?: string | undefined; readonly limit: number },
): HandlerResult<{ items: T[]; nextCursor: string | null }> {
    const outcome = paginate([...items], spec, query);
    if (outcome.kind === 'invalid-cursor') return fail('invalid-cursor');
    return ok({ items: [...outcome.page.items], nextCursor: outcome.page.nextCursor });
}

export function sortBy<T extends { readonly id: string }>(
    name: string,
    key: (item: T) => SortValue,
    descending = false,
): SortSpec<T> {
    return { name, key, descending, id: (item) => item.id };
}

/** `-name` style sort parameters: a leading `-` means descending. */
export function sortParam<T extends { readonly id: string }>(
    sort: string,
    keys: Record<string, (item: T) => SortValue>,
) {
    const descending = sort.startsWith('-');
    const field = descending ? sort.slice(1) : sort;
    const key = keys[field];
    if (!key) throw new Error(`Unsupported sort ${sort}`);
    return sortBy(sort, key, descending);
}

export const time = (timestamp: string): number => Date.parse(timestamp);

/** `from` inclusive, `to` exclusive, either open. */
export function within(at: string, from: string | undefined, to: string | undefined): boolean {
    return (from === undefined || time(at) >= time(from)) && (to === undefined || time(at) < time(to));
}

export function agentRecord(ctx: EngineContext, agentId: string) {
    return ctx.state.agents.get(agentId);
}

export function liveAgent(ctx: EngineContext, agentId: string): HandlerResult<Agent> {
    const record = agentRecord(ctx, agentId);
    if (!record) return notFound('agent');
    if (record.agent.deletedAt !== null) return fail('agent-deleted');
    return ok(record.agent);
}

export function advertises(ctx: EngineContext, capability: CapabilityRef): boolean {
    return supports(ctx.state.engine, capability);
}

/** Text with whitespace runs collapsed to one space, cut to `max` code units; `null` when nothing visible is left. */
export function previewText(content: string, max: number): string | null {
    const text = content.replace(/\s+/g, ' ').trim();
    if (text === '') return null;
    const cut = text.slice(0, max);
    // Never end on the first half of a surrogate pair.
    return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export function memberActor(ctx: HandlerContext): ActivityActor {
    return { kind: 'member', memberId: ctx.member.id };
}

type DistributiveOmit<T, Key extends PropertyKey> = T extends unknown ? Omit<T, Key> : never;

/** An activity before the engine stamps it; the engine also names its agent. */
export type ActivityInput = DistributiveOmit<Activity, 'id' | 'at' | 'v' | 'agentName'>;

/** The name of an item's agent as the engine knows it now, deleted or not; `null` without one. */
export function activityAgentName(ctx: EngineContext, agentId: AgentId | null): string | null {
    return agentId === null ? null : (ctx.state.agents.get(agentId)?.agent.name ?? null);
}

/** Appends to the feed and announces it on the event stream; the stream filters it per member. */
export function recordActivity(ctx: EngineContext, input: ActivityInput): Activity {
    const activity = Activity.parse({
        ...input,
        v: 1,
        id: ctx.newId(ActivityId, 'activity'),
        at: ctx.now(),
        agentName: activityAgentName(ctx, input.agentId),
    });
    ctx.state.activity.push(activity);
    ctx.publish({ type: 'activity', activity });
    return activity;
}
