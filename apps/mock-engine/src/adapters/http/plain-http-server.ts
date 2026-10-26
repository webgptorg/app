import type { Server } from 'node:http';
import { createServer } from 'node:http';

import type { HttpBindings } from '@hono/node-server';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';

import type { Logger } from '../../domain/logger';
import type { RateLimiter } from '../../domain/rate-limit/rate-limiter';
import { applySecurityHeaders } from './http-app';
import type { HttpRoute } from './route';
import { bySpecificity, honoPath, problemResponse, rateLimited, runHttpRoute } from './route-handler';

/** Where a plain-HTTP listener outside the tunnel binds: a TCP address, or a Unix socket path. */
export type PlainListen = { readonly host: string; readonly port: number } | { readonly path: string };

export interface PlainHttpServer {
    /** The bound TCP port; null on a Unix socket. */
    readonly port: number | null;
    close(): Promise<void>;
}

/**
 * Serves `control` routes over plain HTTP outside the tunnel, through the same route helper as everything inside it:
 * strict schemas, a rate limit, problem+json errors without internals, and the engine's security headers.
 */
export async function startPlainHttpServer(deps: {
    readonly routes: readonly HttpRoute[];
    readonly rateLimiter: RateLimiter;
    readonly logger: Logger;
    /** The log event for an unexpected error, e.g. `control.error`. */
    readonly errorEvent: string;
    readonly listen: PlainListen;
}): Promise<PlainHttpServer> {
    const app = new Hono<{ Bindings: HttpBindings }>();
    app.use(async (c, next) => {
        await next();
        applySecurityHeaders(c.res.headers);
    });
    for (const route of [...deps.routes].sort(bySpecificity)) {
        if (route.auth !== 'control')
            throw new Error(`only control routes are served outside the tunnel: ${route.path}`);
        app.on(route.method, honoPath(route.path), async (c) => {
            // A Unix socket has no peer address; its callers share one rate-limit key.
            const clientIp = c.env.incoming.socket.remoteAddress ?? 'local';
            const limited = rateLimited(route, deps.rateLimiter, clientIp);
            if (limited !== null) return problemResponse(limited);
            return runHttpRoute(route, { request: c.req.raw, params: {}, connection: null, clientIp, actor: null });
        });
    }
    app.notFound(() => problemResponse({ code: 'not-found' }));
    app.onError((error) => {
        deps.logger.error(deps.errorEvent, { problem: error.name });
        return problemResponse({ code: 'internal-error' });
    });
    const listener = getRequestListener(app.fetch, { overrideGlobalObjects: false });
    const server: Server = createServer((request, response) => {
        listener(request, response).catch(() => response.destroy());
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        const listening = (): void => {
            server.off('error', reject);
            resolve();
        };
        if ('path' in deps.listen) server.listen(deps.listen.path, listening);
        else server.listen(deps.listen.port, deps.listen.host, listening);
    });
    const address = server.address();
    return {
        port: typeof address === 'object' && address !== null ? address.port : null,
        close: () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(() => {
                    resolve();
                });
            }),
    };
}
