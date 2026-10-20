import type { WebSocket } from 'ws';
import type { z } from 'zod';

import type { RateLimitRule } from '../../domain/rate-limit/rate-limiter';
import type { SecureConnection } from '../tls-stream-server';

/**
 * How a route authenticates; there is no default. Only `public` exists until M-04 adds the gateway session, and every
 * `public` route must be on the allowlist the route-table test checks.
 */
export type AuthMode = 'public';

/** A strict object schema (`z.strictObject`): unknown keys fail, so an unknown query parameter is a 400. */
export type StringFields = z.ZodObject<z.core.$ZodLooseShape, z.core.$strict>;

interface RouteContract<Q extends StringFields, H extends StringFields | null> {
    readonly method: 'GET';
    /** Exact path, no parameters. */
    readonly path: `/${string}`;
    readonly auth: AuthMode;
    /** A permission of the engine's policy; null for `public` routes. */
    readonly permission: null;
    /** A per-client-IP policy; required for every non-session route. */
    readonly rateLimit: RateLimitRule;
    /** Parsed from the URL; a repeated parameter is refused before the schema sees it. */
    readonly query: Q;
    /** Only the headers the route reads, by lowercase name; the rest are ignored. */
    readonly headers: H;
}

type Parsed<S> = S extends z.ZodType ? z.output<S> : null;

export interface RouteRequest<Q extends StringFields, H extends StringFields | null> {
    readonly query: z.output<Q>;
    readonly headers: Parsed<H>;
    readonly connection: SecureConnection;
    /** Aborted when the client goes away. */
    readonly signal: AbortSignal;
}

export interface HttpRoute<
    Q extends StringFields = StringFields,
    H extends StringFields | null = StringFields | null,
> extends RouteContract<Q, H> {
    readonly transport: 'http';
    // Method syntax on purpose: routes with different schemas are stored in one table.
    handle(request: RouteRequest<Q, H>): Response | Promise<Response>;
}

export interface WebSocketRoute<
    Q extends StringFields = StringFields,
    H extends StringFields | null = StringFields | null,
> extends RouteContract<Q, H> {
    readonly transport: 'websocket';
    /** Larger messages close the socket with 1009. */
    readonly maxPayloadBytes: number;
    handle(socket: WebSocket, request: Omit<RouteRequest<Q, H>, 'signal'>): void;
}

export type Route = HttpRoute | WebSocketRoute;

export function defineHttpRoute<const Q extends StringFields, const H extends StringFields | null>(
    route: HttpRoute<Q, H>,
): HttpRoute<Q, H> {
    return route;
}

export function defineWebSocketRoute<const Q extends StringFields, const H extends StringFields | null>(
    route: WebSocketRoute<Q, H>,
): WebSocketRoute<Q, H> {
    return route;
}
