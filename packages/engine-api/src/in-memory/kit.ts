import type { z } from 'zod';

import type { Agent } from '../agents';
import { Activity } from '../capabilities/activity';
import type { ActivityActor } from '../capabilities/activity';
import { supports } from '../capabilities/capability';
import type { CapabilityRef } from '../capabilities/capability';
import { ActivityId } from '../common';
import type { ProblemDetails, Timestamp } from '../common';
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

export type HandlerResult<T> =
    { readonly kind: 'ok'; readonly data: T } | { readonly kind: 'problem'; readonly problem: ProblemDetails };

export interface ScriptedReply {
    readonly chunks: readonly string[];
    /** `failed` ends the stream with `reply-failed` after the chunks. */
    readonly outcome?: 'completed' | 'failed';
}

export type ReplyScript = (input: { readonly agent: Agent; readonly content: string }) => ScriptedReply;

/** What the engine itself needs to act, with or without a member request (the controller acts as the system). */
export interface EngineContext {
    readonly state: InMemoryState;
    readonly now: () => Timestamp;
    readonly newId: <Schema extends z.ZodType<string, string>>(schema: Schema, prefix: string) => z.output<Schema>;
    readonly publish: (event: EngineEvent) => void;
}

export interface HandlerContext extends EngineContext {
    readonly member: Member;
    readonly permissions: ReadonlySet<Permission>;
    /** Resolves when an event after `count` events exists, rejects when `signal` aborts. */
    readonly nextEvent: (count: number, signal: AbortSignal) => Promise<void>;
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

export function memberActor(ctx: HandlerContext): ActivityActor {
    return { kind: 'member', memberId: ctx.member.id };
}

type DistributiveOmit<T, Key extends PropertyKey> = T extends unknown ? Omit<T, Key> : never;

/** An activity before the engine stamps it. */
export type ActivityInput = DistributiveOmit<Activity, 'id' | 'at' | 'v'>;

/** Appends to the feed and announces it on the event stream; the stream filters it per member. */
export function recordActivity(ctx: EngineContext, input: ActivityInput): Activity {
    const activity = Activity.parse({ ...input, v: 1, id: ctx.newId(ActivityId, 'activity'), at: ctx.now() });
    ctx.state.activity.push(activity);
    ctx.publish({ type: 'activity', activity });
    return activity;
}
