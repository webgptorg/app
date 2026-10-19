import type { z } from 'zod';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * One `/api` endpoint as data. The Hono route and the SPA client are both derived from it, so the contract is explicit
 * and reviewable, and neither side infers the other's types.
 */
export interface RouteContract {
    readonly method: HttpMethod;
    /** Full path with Hono-style parameters, e.g. `/api/engines/:engineId`. */
    readonly path: `/api/${string}`;
    readonly params: z.ZodType<Readonly<Record<string, string>>> | null;
    readonly query: z.ZodType<Readonly<Partial<Record<string, string>>>> | null;
    readonly body: z.ZodType | null;
    readonly response: z.ZodType;
    /** Endpoint-specific problem codes, on top of the common ones. */
    readonly errorCodes: readonly string[];
}

type Part<S, K extends string> = S extends z.ZodType ? { readonly [P in K]: z.input<S> } : unknown;
type ParsedPart<S, K extends string> = S extends z.ZodType ? { readonly [P in K]: z.output<S> } : unknown;

/** What the caller supplies. */
export type RouteInput<C extends RouteContract> = Part<C['params'], 'params'> &
    Part<C['query'], 'query'> &
    Part<C['body'], 'body'>;

/** What the handler receives after validation. */
export type ParsedRouteInput<C extends RouteContract> = ParsedPart<C['params'], 'params'> &
    ParsedPart<C['query'], 'query'> &
    ParsedPart<C['body'], 'body'>;

export type RouteResponse<C extends RouteContract> = z.output<C['response']>;
export type RouteErrorCode<C extends RouteContract> = C['errorCodes'][number];

export function defineRoute<const C extends RouteContract>(contract: C): C {
    return contract;
}
