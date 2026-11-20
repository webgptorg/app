import type { z } from 'zod';

import type { CapabilityRef } from './capabilities/capability';
import type { Permission } from './permissions';
import type { ProblemCode } from './problem-codes';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type SuccessStatus = 200 | 201 | 202 | 204;

export type RouteBody =
    | { readonly kind: 'json'; readonly schema: z.ZodType }
    | { readonly kind: 'multipart'; readonly schema: z.ZodObject }
    /**
     * The raw request body as one `Blob`, its `Content-Type` one of `mediaTypes` after `normalizeMediaType`. Anything
     * else is 415 `unsupported-media-type`, more than `maxBytes` is 413 `payload-too-large`, both before the engine
     * looks at the bytes. The handler gets a `Blob` typed with the matched media type.
     */
    | {
          readonly kind: 'binary';
          readonly schema: z.ZodType<Blob>;
          readonly mediaTypes: readonly string[];
          readonly maxBytes: number;
      };

/** An SSE event schema; every event's `type` is also sent as the SSE `event` field. */
export type SseEventSchema = z.ZodType<{ readonly type: string }>;

/**
 * `schema` is what the engine must send, checked strictly on the engine side (unknown fields fail). Clients read
 * tolerantly (ADR 0010 §3): by default `toTolerant(schema)`, or `read` where the client needs more than stripping
 * unknown fields, e.g. open sets that keep unknown members (activity kinds, integration kinds).
 */
export type RouteResponse =
    | { readonly kind: 'json'; readonly schema: z.ZodType; readonly read?: z.ZodType }
    | { readonly kind: 'empty' }
    /** An SSE `read` resolves to `null` for events the client skips. */
    | { readonly kind: 'sse'; readonly event: SseEventSchema; readonly read?: z.ZodType }
    /**
     * Raw bytes. Without `mediaTypes` a download: always `application/octet-stream` as an attachment. With them the
     * engine sends one of these as `Content-Type`, still with `nosniff` and as an attachment, and the client checks it.
     */
    | { readonly kind: 'binary'; readonly mediaTypes?: readonly string[] };

/**
 * One operation of the engine API. Framework-agnostic on purpose: the client, the OpenAPI document, the conformance
 * suite and any engine (Hono, Fastify, ...) are all driven by the same table.
 */
export interface RouteDefinition {
    /** Operation ID, unique across the API. */
    readonly id: string;
    readonly method: HttpMethod;
    /** Relative to `ENGINE_API_PREFIX`, with `{name}` placeholders matching `params`. */
    readonly path: `/${string}`;
    readonly summary: string;
    /** Behaviour a client relies on beyond the summary; emitted as the OpenAPI operation description. */
    readonly description?: string;
    /**
     * `null` only for `/me`, `/me/**` and `/engine`, which any signed-in member may call. `null` is not "no
     * authorization": routes under `/me` act only on the caller's own resources and answer 404 for anyone else's.
     */
    readonly permission: Permission | null;
    /** Set on every route of an optional capability; an engine that does not advertise it answers 404 `capability-not-supported`. */
    readonly capability?: CapabilityRef;
    readonly params?: z.ZodObject;
    readonly query?: z.ZodObject;
    readonly body?: RouteBody;
    /** Exactly one success response. */
    readonly responses: Readonly<Partial<Record<SuccessStatus, RouteResponse>>>;
    /** Route-specific problems, on top of those every route may return (see `COMMON_PROBLEMS`). */
    readonly problems?: readonly ProblemCode[];
    /** The gateway may answer 401 `step-up-required` until the member confirms with a fresh passkey assertion. */
    readonly stepUp?: true;
    /** Shape designed, behaviour not committed yet; engines may answer 404 `not-found`. */
    readonly draft?: true;
}

export function defineRoute<const Route extends RouteDefinition>(route: Route): Route {
    return route;
}

type ParamsOf<Route> = Route extends { readonly params: infer Params extends z.ZodObject } ? Params : never;
type QueryOf<Route> = Route extends { readonly query: infer Query extends z.ZodObject } ? Query : never;
type BodyOf<Route> = Route extends { readonly body: { readonly schema: infer Body extends z.ZodType } } ? Body : never;
type SuccessOf<Route> = Route extends { readonly responses: infer Responses } ? Responses[keyof Responses] : never;
type IsSse<Route> = SuccessOf<Route> extends { readonly kind: 'sse' } ? true : false;

/** What a caller passes: parameters and bodies before parsing, so defaults may be omitted. */
export type RouteRequest<Route> = ([ParamsOf<Route>] extends [never]
    ? unknown
    : { readonly params: z.input<ParamsOf<Route>> }) &
    ([QueryOf<Route>] extends [never] ? unknown : { readonly query?: z.input<QueryOf<Route>> }) &
    ([BodyOf<Route>] extends [never] ? unknown : { readonly body: z.input<BodyOf<Route>> }) &
    (IsSse<Route> extends true ? { readonly lastEventId?: string } : unknown);

/** What a handler receives after the engine parsed the request. */
export interface ParsedRouteRequest<Route> {
    readonly params: [ParamsOf<Route>] extends [never] ? Record<string, never> : z.output<ParamsOf<Route>>;
    readonly query: [QueryOf<Route>] extends [never] ? Record<string, never> : z.output<QueryOf<Route>>;
    readonly body: [BodyOf<Route>] extends [never] ? undefined : z.output<BodyOf<Route>>;
    readonly lastEventId: string | null;
}

/** One SSE event with the SSE `id` it arrived with; resume a stream by passing the last one as `lastEventId`. */
export interface EngineApiStreamItem<Event> {
    readonly id: string | null;
    readonly event: Event;
}

type ResponseData<Response> = Response extends { readonly kind: 'json'; readonly read: infer Read extends z.ZodType }
    ? z.output<Read>
    : Response extends { readonly kind: 'json'; readonly schema: infer Schema extends z.ZodType }
      ? z.output<Schema>
      : Response extends { readonly kind: 'sse'; readonly read: infer Read extends z.ZodType }
        ? AsyncIterable<EngineApiStreamItem<Exclude<z.output<Read>, null>>>
        : Response extends { readonly kind: 'sse'; readonly event: infer Event extends z.ZodType }
          ? AsyncIterable<EngineApiStreamItem<z.output<Event>>>
          : Response extends { readonly kind: 'binary' }
            ? Blob
            : null;

/** What a client resolves with: the tolerant reading of the response. */
export type RouteData<Route> = ResponseData<SuccessOf<Route>>;

type EngineResponseData<Response> = Response extends {
    readonly kind: 'json';
    readonly schema: infer Schema extends z.ZodType;
}
    ? z.output<Schema>
    : Response extends { readonly kind: 'sse'; readonly event: infer Event extends z.ZodType }
      ? AsyncIterable<EngineApiStreamItem<z.output<Event>>>
      : Response extends { readonly kind: 'binary' }
        ? Blob
        : null;

/** What an engine answers with, before it goes on the wire: exactly the route's strict schema. */
export type RouteEngineData<Route> = EngineResponseData<SuccessOf<Route>>;
