import type { z } from 'zod';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * How a route authenticates; there is no default. `public` routes are an allowlist checked by the route-table test.
 * `stripe-signature` routes are verified over the raw body before anything parses it. `engine-signature` routes carry
 * the engine key's signature inside a strictly parsed body (C-03's registration), and the handler's first step
 * verifies it before reading any state. `relay-token` routes take a relay key as a bearer token (D-04) and are rate
 * limited per relay.
 */
export type AuthMode = 'public' | 'session' | 'stripe-signature' | 'engine-signature' | 'relay-token';

export interface RouteInput {
    readonly params: z.ZodType<Readonly<Record<string, string>>> | null;
    readonly query: z.ZodType<Readonly<Partial<Record<string, string>>>> | null;
    /** Only the headers the route reads, lowercase names; the rest are ignored. */
    readonly headers: z.ZodType<Readonly<Partial<Record<string, string>>>> | null;
    readonly body: z.ZodType | null;
    /** Refused with 413 above this size; 0 when the route takes no body. */
    readonly maxBodyBytes: number;
}

/**
 * One HTTP endpoint as data: strict input schemas, the auth mode, the permission a session needs, the rate limit an
 * anonymous caller is held to, and the output. The server binds a handler to it (`bindRoute`), the SPA calls it
 * through the typed client, and neither side infers the other's types.
 */
export interface RouteContract {
    readonly method: HttpMethod;
    /** Full path with Hono-style parameters, e.g. `/api/engines/:engineId`. */
    readonly path: `/${string}`;
    readonly auth: AuthMode;
    /** An action of the app's policy table; required for `session` routes. */
    readonly permission: string | null;
    /** A per-IP rate limit rule, or a per-relay one for `relay-token` routes; required for every non-session route. */
    readonly rateLimit: string | null;
    readonly input: RouteInput;
    /** Strict, so tests prove the server sends no undeclared field; the client reads it tolerantly. */
    readonly output: z.ZodType;
    /** Endpoint-specific problem codes, on top of the common ones. */
    readonly errorCodes: readonly string[];
}

type Part<S, K extends string> = S extends z.ZodType ? { readonly [P in K]: z.input<S> } : unknown;
type ParsedPart<S, K extends string> = S extends z.ZodType ? { readonly [P in K]: z.output<S> } : unknown;

/** What the caller supplies. */
export type RouteCallInput<C extends RouteContract> = Part<C['input']['params'], 'params'> &
    Part<C['input']['query'], 'query'> &
    Part<C['input']['body'], 'body'>;

/** What the handler receives after validation. */
export type ParsedRouteInput<C extends RouteContract> = ParsedPart<C['input']['params'], 'params'> &
    ParsedPart<C['input']['query'], 'query'> &
    ParsedPart<C['input']['headers'], 'headers'> &
    ParsedPart<C['input']['body'], 'body'>;

export type RouteResponse<C extends RouteContract> = z.output<C['output']>;
export type RouteErrorCode<C extends RouteContract> = C['errorCodes'][number];

export function defineRoute<const C extends RouteContract>(contract: C): C {
    return contract;
}

/** Input of a route that takes nothing. */
export const NO_INPUT = { params: null, query: null, headers: null, body: null, maxBodyBytes: 0 } as const;
