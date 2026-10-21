import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { HttpBindings } from '@hono/node-server';
import { getRequestListener } from '@hono/node-server';
import { Permission, Role } from '@ptbk/engine-api';
import { Hono } from 'hono';
import { z } from 'zod';

import type { FaultPlan } from '../domain/faults/fault-plan';
import { FaultPlan as FaultPlanSchema, NO_FAULTS } from '../domain/faults/fault-plan';
import type { SessionStore } from '../domain/gateway/sessions';
import type { HeartbeatStatus } from '../domain/heartbeat/heartbeat-loop';
import { SESSION_COOKIE_NAME } from '../domain/gateway/sessions';
import type { Logger } from '../domain/logger';
import type { RateLimiter } from '../domain/rate-limit/rate-limiter';
import type { EngineRuntime } from '../domain/state/engine-runtime';
import { Scenario } from '../domain/state/scenarios';
import { BASELINE_HEADERS } from './http/http-app';
import type { HttpRoute } from './http/route';
import { defineHttpRoute } from './http/route';
import { bySpecificity, honoPath, problemResponse, rateLimited, runHttpRoute } from './http/route-handler';

const NO_QUERY = z.strictObject({});
const BODY_MAX_BYTES = 16 * 1024;
const MAX_SEED = 2 ** 32 - 1;

/** Who a test session is for. Permission sets get a new synthetic member each, so two of them are two members. */
export const SessionSubject = z.union([
    z.strictObject({ kind: z.literal('owner') }),
    z.strictObject({ kind: z.literal('member'), role: Role }),
    z.strictObject({ kind: z.literal('member'), permissions: z.array(Permission).max(64) }),
]);

export interface FaultSettings {
    plan(): FaultPlan;
    set(plan: FaultPlan): void;
}

export function createFaultSettings(initial: FaultPlan): FaultSettings {
    let plan = initial;
    return {
        plan: () => plan,
        set(next) {
            plan = next;
        },
    };
}

export interface ControlDeps {
    readonly runtime: EngineRuntime;
    readonly sessions: SessionStore;
    readonly faults: FaultSettings;
    readonly rateLimiter: RateLimiter;
    /** The last heartbeat sent and the clock skew the dashboard reported; absent in the M1 dev mode. */
    readonly heartbeat?: () => HeartbeatStatus;
    readonly logger: Logger;
    /** RFC 3339, for synthetic members' `createdAt`. */
    readonly now: () => string;
}

/** The dev-only control routes. They live on their own listener and the in-tunnel app refuses `control` routes. */
export function createControlRoutes(deps: ControlDeps): readonly HttpRoute[] {
    const { runtime, sessions } = deps;
    let synthetic = 0;
    const control = <const B extends HttpRoute['body']>(
        route: Omit<
            HttpRoute<null, typeof NO_QUERY, null, B, 'control'>,
            'transport' | 'auth' | 'permission' | 'rateLimit' | 'params' | 'query' | 'headers'
        >,
    ) =>
        defineHttpRoute({
            transport: 'http',
            auth: 'control',
            permission: null,
            rateLimit: 'control',
            params: null,
            query: NO_QUERY,
            headers: null,
            ...route,
        });

    function addMember(role: Role, label: string): string {
        synthetic++;
        const id = `member-synthetic-${String(synthetic).padStart(4, '0')}`;
        runtime.controller().addMember({
            id,
            displayName: `${label} ${String(synthetic)}`,
            role,
            status: 'active',
            createdAt: deps.now(),
            lastSeenAt: null,
        });
        return id;
    }

    function memberFor(subject: z.output<typeof SessionSubject>): {
        readonly memberId: string;
        readonly permissions: readonly Permission[] | null;
    } {
        const members = runtime.controller().inspect().members;
        if (subject.kind === 'owner' || 'role' in subject) {
            const role = subject.kind === 'owner' ? 'owner' : subject.role;
            const found = members.find((member) => member.role === role && member.status === 'active');
            return { memberId: found?.id ?? addMember(role, `Synthetic ${role}`), permissions: null };
        }
        return { memberId: addMember('member', 'Synthetic member'), permissions: subject.permissions };
    }

    return [
        control({
            method: 'GET',
            path: '/__mock/state',
            body: null,
            handle: () => Response.json({ ...runtime.current(), counts: runtime.controller().inspect().counts }),
        }),
        control({
            method: 'POST',
            path: '/__mock/reset',
            body: {
                kind: 'json',
                schema: z.strictObject({ scenario: Scenario, seed: z.int().min(0).max(MAX_SEED) }),
                maxBytes: BODY_MAX_BYTES,
            },
            handle: ({ body }) => {
                runtime.reset(body);
                return Response.json({ ...runtime.current(), counts: runtime.controller().inspect().counts });
            },
        }),
        control({
            method: 'PUT',
            path: '/__mock/faults',
            body: { kind: 'json', schema: FaultPlanSchema, maxBytes: BODY_MAX_BYTES },
            handle: ({ body }) => {
                deps.faults.set(body);
                return Response.json(body);
            },
        }),
        control({
            method: 'DELETE',
            path: '/__mock/faults',
            body: null,
            handle: () => {
                deps.faults.set(NO_FAULTS);
                return new Response(null, { status: 204 });
            },
        }),
        control({
            method: 'GET',
            path: '/__mock/heartbeat',
            body: null,
            handle: () => Response.json(deps.heartbeat?.() ?? { lastHeartbeat: null, clockSkew: null }),
        }),
        control({
            method: 'GET',
            path: '/__mock/members',
            body: null,
            handle: () =>
                Response.json({
                    members: runtime
                        .controller()
                        .inspect()
                        .members.map(({ id, displayName, role, status }) => ({ id, displayName, role, status })),
                }),
        }),
        control({
            method: 'POST',
            path: '/__mock/sessions',
            body: { kind: 'json', schema: z.strictObject({ subject: SessionSubject }), maxBytes: BODY_MAX_BYTES },
            handle: ({ body, clientIp }) => {
                const { memberId, permissions } = memberFor(body.subject);
                const signedIn = sessions.signIn({
                    memberId,
                    permissions,
                    client: { ip: clientIp, userAgent: 'mock control listener' },
                });
                return Response.json(
                    { memberId: signedIn.memberId, cookie: { name: SESSION_COOKIE_NAME, value: signedIn.token } },
                    { status: 201 },
                );
            },
        }),
    ];
}

export interface ControlServer {
    readonly port: number;
    readonly routes: readonly HttpRoute[];
    close(): Promise<void>;
}

/** Plain HTTP on `host:port` (default loopback only); never reachable through the tunnel. */
export async function startControlServer(
    deps: ControlDeps & { readonly host: string; readonly port: number },
): Promise<ControlServer> {
    const routes = createControlRoutes(deps);
    const app = new Hono<{ Bindings: HttpBindings }>();
    app.use(async (c, next) => {
        await next();
        for (const [name, value] of Object.entries(BASELINE_HEADERS)) c.res.headers.set(name, value);
    });
    for (const route of [...routes].sort(bySpecificity)) {
        app.on(route.method, honoPath(route.path), async (c) => {
            const clientIp = c.env.incoming.socket.remoteAddress ?? '127.0.0.1';
            const limited = rateLimited(route, deps.rateLimiter, clientIp);
            if (limited !== null) return problemResponse(limited);
            return runHttpRoute(route, { request: c.req.raw, params: {}, connection: null, clientIp, actor: null });
        });
    }
    app.notFound(() => problemResponse({ code: 'not-found' }));
    app.onError((error) => {
        deps.logger.error('control.error', { problem: error.name });
        return problemResponse({ code: 'internal-error' });
    });
    const listener = getRequestListener(app.fetch, { overrideGlobalObjects: false });
    const server: Server = createServer((request, response) => {
        listener(request, response).catch(() => response.destroy());
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(deps.port, deps.host, () => {
            server.off('error', reject);
            resolve();
        });
    });
    const { port } = server.address() as AddressInfo;
    deps.logger.info('control.listening', { host: deps.host, port });
    return {
        port,
        routes,
        close: () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(() => {
                    resolve();
                });
            }),
    };
}
