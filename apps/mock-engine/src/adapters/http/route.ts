import type { Permission } from '@ptbk/engine-api';
import type { Actor } from '@ptbk/engine-api/in-memory';
import type { WebSocket } from 'ws';
import type { z } from 'zod';

import type { RateLimitRule } from '../../domain/rate-limit/rate-limiter';
import type { SecureConnection } from '../tls-stream-server';

/**
 * How a route authenticates; there is no default. `public` routes are on the allowlist the route-table test checks;
 * `session` routes run behind the gateway and receive its {@link Actor}; `control` routes exist only on the dev-only
 * control listener, which the in-tunnel app refuses to mount.
 */
export type AuthMode = 'public' | 'session' | 'control';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A strict object schema (`z.strictObject`): unknown keys fail, so an unknown query parameter is a 400. */
export type StringFields = z.ZodObject<z.core.$ZodLooseShape, z.core.$strict>;

/** A body is read only up to `maxBytes` (413 beyond), then parsed by its media type and checked by `schema`. */
export type RouteBody =
    | { readonly kind: 'json'; readonly schema: z.ZodType; readonly maxBytes: number }
    | { readonly kind: 'multipart'; readonly schema: z.ZodType; readonly maxBytes: number }
    /** `application/x-www-form-urlencoded`, as an HTML form posts it. */
    | { readonly kind: 'form'; readonly schema: z.ZodType; readonly maxBytes: number };

type Params = z.ZodObject | null;

interface RouteContract<P extends Params, Q extends z.ZodObject, H extends StringFields | null, A extends AuthMode> {
    readonly method: HttpMethod;
    /** Exact, or with `{name}` segments that `params` declares. */
    readonly path: `/${string}`;
    readonly auth: A;
    /**
     * A permission of the engine's policy, or `null` for `public` and `control` routes and for the self-scoped session
     * routes on the route-table test's allowlist.
     */
    readonly permission: Permission | null;
    /** A per-client-IP policy; every route has one. */
    readonly rateLimit: RateLimitRule;
    readonly params: P;
    /** Parsed from the URL; a repeated parameter is refused before the schema sees it. */
    readonly query: Q;
    /** Only the headers the route reads, by lowercase name; the rest are ignored. */
    readonly headers: H;
}

type Parsed<S> = S extends z.ZodType ? z.output<S> : null;

export interface RouteRequest<
    P extends Params,
    Q extends z.ZodObject,
    H extends StringFields | null,
    B extends RouteBody | null,
    A extends AuthMode,
> {
    readonly params: Parsed<P>;
    readonly query: z.output<Q>;
    readonly headers: Parsed<H>;
    readonly body: B extends RouteBody ? z.output<B['schema']> : null;
    /** The request as received, with its (size-checked) body readable once more, for handlers that parse it again. */
    readonly request: Request;
    /** The TLS connection inside the tunnel; the control listener has none. */
    readonly connection: A extends 'control' ? null : SecureConnection;
    readonly clientIp: string;
    /** Who the gateway signed in, for `session` routes. */
    readonly actor: A extends 'session' ? Actor : null;
    /** Aborted when the client goes away. */
    readonly signal: AbortSignal;
}

export interface HttpRoute<
    P extends Params = Params,
    Q extends z.ZodObject = z.ZodObject,
    H extends StringFields | null = StringFields | null,
    B extends RouteBody | null = RouteBody | null,
    A extends AuthMode = AuthMode,
> extends RouteContract<P, Q, H, A> {
    readonly transport: 'http';
    readonly body: B;
    /**
     * `engine-api`: only the engine API routes, whose binding validates params, query and body with these same strict
     * schemas after checking capability and permission (C-04's order). The handler then gets the raw path parameters.
     */
    readonly validation?: 'engine-api';
    // Method syntax on purpose: routes with different schemas are stored in one table.
    handle(request: RouteRequest<P, Q, H, B, A>): Response | Promise<Response>;
}

export interface WebSocketRoute<
    Q extends z.ZodObject = z.ZodObject,
    H extends StringFields | null = StringFields | null,
> extends RouteContract<null, Q, H, 'public'> {
    readonly transport: 'websocket';
    readonly method: 'GET';
    /** Larger messages close the socket with 1009. */
    readonly maxPayloadBytes: number;
    handle(
        socket: WebSocket,
        request: Pick<RouteRequest<null, Q, H, null, 'public'>, 'query' | 'headers' | 'connection'>,
    ): void;
}

export type Route = HttpRoute | WebSocketRoute;

export function defineHttpRoute<
    const P extends Params,
    const Q extends z.ZodObject,
    const H extends StringFields | null,
    const B extends RouteBody | null,
    const A extends AuthMode,
>(route: HttpRoute<P, Q, H, B, A>): HttpRoute<P, Q, H, B, A> {
    return route;
}

export function defineWebSocketRoute<const Q extends z.ZodObject, const H extends StringFields | null>(
    route: WebSocketRoute<Q, H>,
): WebSocketRoute<Q, H> {
    return route;
}
