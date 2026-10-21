import { ENGINE_API_PREFIX, OWNER_PERMISSIONS, createProblem } from '@ptbk/engine-api';
import type { CapabilityRef, Permission } from '@ptbk/engine-api';
import { createEngineApiHttpHandler } from '@ptbk/engine-api/http';
import { createDemoSeed, createInMemoryEngineCore } from '@ptbk/engine-api/in-memory';
import type { Actor, Authorizer, InMemoryEngineCore } from '@ptbk/engine-api/in-memory';
import { buildHeartbeat, deriveEngineId, encodeBase64Url } from '@ptbk/protocol';

import type { ConformanceTarget, SessionSubject } from '../target';

/** One deliberate contract violation each; the self-test proves the matching check catches it. */
export const DEFECTS = [
    'leaked-secret',
    'extra-field',
    'missing-auth',
    'missing-permission-check',
    'plain-text-403',
    'duplicate-page-item',
    'missing-audit-entry',
    'wrong-audit-member',
    'wrong-problem-content-type',
] as const;
export type Defect = (typeof DEFECTS)[number];

export interface FakeEngineOptions {
    readonly defect?: Defect;
    readonly capabilities?: readonly CapabilityRef[];
    /** Without one, `/security` reports no heartbeat yet. */
    readonly heartbeat?: boolean;
    /** Whether the fake reports agents as private to their creator (as the mock engine's policy does). */
    readonly memberPrivate?: boolean;
    /** Rewrites any API answer, for tests that break one assertion at a time. */
    readonly tamper?: Tamper;
}

export type Tamper = (request: Request, response: Response) => Response | Promise<Response>;

export interface FakeEngine {
    readonly target: ConformanceTarget;
    readonly core: InMemoryEngineCore;
    readonly handle: (request: Request) => Promise<Response>;
}

const ORIGIN_HOST_DOMAIN = 'engine.test';
const COOKIE = 'fake_session';
const OWNER = 'member-owner';
const SPARE_MEMBERS = 80;
const AGENT_CHANGES: ReadonlySet<Permission> = new Set(['agents.write', 'agents.delete', 'agents.run']);

/** Without `members.manage`, a member changes only agents they created: the policy the mock engine also has. */
const OWNERSHIP: Authorizer = {
    can(actor, permission, resource) {
        if (!actor.permissions.has(permission)) return { kind: 'deny', reason: 'missing-permission' };
        const foreign =
            resource?.kind === 'agent' &&
            typeof resource.createdBy === 'string' &&
            resource.createdBy !== actor.memberId;
        if (foreign && AGENT_CHANGES.has(permission) && !actor.permissions.has('members.manage')) {
            return { kind: 'deny', reason: 'not-owner' };
        }
        return { kind: 'allow' };
    },
};

/**
 * An engine in this process: `@ptbk/engine-api`'s in-memory engine behind a small gateway (session cookie, Fetch
 * Metadata), served through its HTTP binding, so every byte the suite judges is real HTTP semantics without sockets.
 */
export async function createFakeEngine(options: FakeEngineOptions = {}): Promise<FakeEngine> {
    const now = new Date();
    const at = (minutes: number): string => new Date(now.getTime() - minutes * 60_000).toISOString();
    const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
    const engineId = await deriveEngineId(publicKey);
    const hostname = `${engineId}.${ORIGIN_HOST_DOMAIN}`;
    const baseUrl = new URL(`https://${hostname}`);

    const demo = createDemoSeed(now);
    const spares = Array.from(
        { length: SPARE_MEMBERS },
        (_, index) => `member-fake-${String(index + 1).padStart(3, '0')}`,
    );
    const core = createInMemoryEngineCore({
        seed: {
            ...demo,
            members: [
                ...(demo.members ?? []),
                ...spares.map((id) => ({
                    id,
                    displayName: `Synthetic ${id}`,
                    role: 'member' as const,
                    status: 'active' as const,
                    createdAt: at(600),
                    lastSeenAt: null,
                })),
            ],
            passkeys: [OWNER, ...spares].flatMap((memberId) =>
                ['a', 'b'].map((suffix) => ({
                    id: `passkey-${memberId}-${suffix}`,
                    memberId,
                    name: `Key ${suffix}`,
                    createdAt: at(500),
                    lastUsedAt: null,
                })),
            ),
            sessions: [],
        },
        ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
        authorizer: OWNERSHIP,
    });
    core.controller.updateEngine({ engineId, hostname, mode: 'tunnel' });
    if (options.heartbeat !== false) {
        const body = buildHeartbeat({
            engineId,
            seq: 1,
            ts: at(1).replace(/\.\d{3}Z$/, 'Z'),
            version: '1.0.0',
            uptimeS: 60,
            diskPct: 40,
            ramPct: 30,
            cpuLoad: 'low',
            update: 'none',
            agents: 3,
            members: 2,
        } as Parameters<typeof buildHeartbeat>[0]);
        core.controller.updateSecurity({ lastHeartbeat: { sentAt: at(1), body: new TextDecoder().decode(body) } });
    }

    const actors = new Map<string, Actor>();
    let issued = 0;
    function signIn(subject: SessionSubject): string {
        issued++;
        const memberId = subject.kind === 'owner' ? OWNER : (spares[issued % SPARE_MEMBERS] ?? OWNER);
        const sessionId = `session-fake-${String(issued).padStart(4, '0')}`;
        core.controller.addSession({
            id: sessionId,
            memberId,
            client: { ip: '192.0.2.10', userAgent: 'fake engine' },
            createdAt: now.toISOString(),
            lastSeenAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
        });
        const token = `token-${String(issued).padStart(4, '0')}`;
        actors.set(token, {
            memberId: memberId as Actor['memberId'],
            sessionId: sessionId as Actor['sessionId'],
            client: { ip: '192.0.2.10', userAgent: 'fake engine' },
            permissions: new Set(subject.kind === 'owner' ? OWNER_PERMISSIONS : subject.permissions),
            stepUpFresh: true,
        });
        return token;
    }

    const defect = createDefect(options.defect, actors);
    const answer = async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        if (!url.pathname.startsWith(`${ENGINE_API_PREFIX}/`)) return problem('not-found');
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
            const site = request.headers.get('sec-fetch-site');
            if (request.headers.get('origin') !== baseUrl.origin || (site !== 'same-origin' && site !== 'none')) {
                return problem('forbidden');
            }
        }
        const token = /(?:^|;\s*)fake_session=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1];
        let actor = token === undefined ? undefined : actors.get(token);
        const live = core.controller.inspect().sessions.some(({ id }) => id === actor?.sessionId);
        if (!live) actor = defect.anonymous(request);
        if (actor === undefined) return problem('unauthenticated');
        const serve = createEngineApiHttpHandler(core.transport(defect.actor(request, actor)));
        return defect.response(request, await serve(await defect.request(request)));
    };
    const handle = async (request: Request): Promise<Response> => {
        if (options.tamper === undefined) return answer(request);
        const original = request.clone();
        return options.tamper(original, await answer(request));
    };

    return {
        core,
        handle,
        target: {
            baseUrl,
            fetch: (input, init) => handle(new Request(input, init)),
            enginePublicKey: encodeBase64Url(publicKey),
            ...(options.memberPrivate === false
                ? {}
                : {
                      memberPrivateResources: {
                          permissions: OWNER_PERMISSIONS.filter((permission) => permission !== 'members.manage'),
                          agentRoutes: ['updateAgent', 'updateAgentSource', 'deleteAgent', 'restoreAgent'],
                      },
                  }),
            session: (subject) => Promise.resolve({ cookie: `${COOKIE}=${signIn(subject)}` }),
        },
    };
}

function problem(code: 'not-found' | 'forbidden' | 'unauthenticated'): Response {
    return new Response(JSON.stringify(createProblem(code)), {
        status: createProblem(code).status,
        headers: { 'content-type': 'application/problem+json' },
    });
}

interface DefectHooks {
    /** The actor an unauthenticated request runs as; `undefined` refuses it. */
    anonymous(request: Request): Actor | undefined;
    actor(request: Request, actor: Actor): Actor;
    request(request: Request): Promise<Request>;
    response(request: Request, response: Response): Promise<Response>;
}

/** The hooks that make the fake break the contract in exactly one way. */
function createDefect(defect: Defect | undefined, actors: ReadonlyMap<string, Actor>): DefectHooks {
    const path = (request: Request): string => new URL(request.url).pathname.slice(ENGINE_API_PREFIX.length);
    const is = (request: Request, method: string, pattern: RegExp): boolean =>
        request.method === method && pattern.test(path(request));
    const hooks: DefectHooks = {
        anonymous: () => undefined,
        actor: (_, actor) => actor,
        request: (request) => Promise.resolve(request),
        response: (_, response) => Promise.resolve(response),
    };
    const editJson = async (
        response: Response,
        edit: (data: Record<string, unknown>) => unknown,
    ): Promise<Response> => {
        if (response.headers.get('content-type') !== 'application/json') return response;
        const data = (await response.json()) as Record<string, unknown>;
        return new Response(JSON.stringify(edit(data)), { status: response.status, headers: response.headers });
    };
    const editAudit = (
        request: Request,
        response: Response,
        edit: (entries: Record<string, unknown>[]) => unknown[],
    ) =>
        is(request, 'GET', /^\/audit$/)
            ? editJson(response, (page) => ({ ...page, items: edit(page['items'] as Record<string, unknown>[]) }))
            : Promise.resolve(response);

    switch (defect) {
        case undefined:
            return hooks;
        case 'leaked-secret': {
            const values: string[] = [];
            return {
                ...hooks,
                async request(request) {
                    if (is(request, 'POST', /^\/secrets$/) || is(request, 'PUT', /^\/secrets\/[^/]+\/value$/)) {
                        const body = (await request.clone().json()) as { readonly value?: unknown };
                        if (typeof body.value === 'string') values.push(body.value);
                    }
                    return request;
                },
                response(request, response) {
                    if (!is(request, 'GET', /^\/agents$/) || values.length === 0) return Promise.resolve(response);
                    const hex = Array.from(new TextEncoder().encode(values.at(-1)), (byte) =>
                        byte.toString(16).padStart(2, '0'),
                    ).join('');
                    return editJson(response, (page) => ({
                        ...page,
                        items: (page['items'] as { profile: { description: string } }[]).map((agent) => ({
                            ...agent,
                            profile: { ...agent.profile, description: `${agent.profile.description} ${hex}` },
                        })),
                    }));
                },
            };
        }
        case 'extra-field':
            return {
                ...hooks,
                response: (request, response) =>
                    is(request, 'GET', /^\/members\/[^/]+$/)
                        ? editJson(response, (member) => ({ ...member, internalNote: 'debug' }))
                        : Promise.resolve(response),
            };
        case 'missing-auth':
            return {
                ...hooks,
                anonymous: (request) =>
                    is(request, 'GET', /^\/folders$/)
                        ? [...actors.values()].find(({ memberId }) => memberId === OWNER)
                        : undefined,
            };
        case 'missing-permission-check':
            return {
                ...hooks,
                actor: (request, actor) =>
                    is(request, 'POST', /^\/folders$/)
                        ? { ...actor, permissions: new Set([...actor.permissions, 'agents.write' as const]) }
                        : actor,
            };
        case 'plain-text-403':
            return {
                ...hooks,
                response: (_, response) =>
                    Promise.resolve(
                        response.status === 403
                            ? new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain' } })
                            : response,
                    ),
            };
        case 'duplicate-page-item': {
            const lastOfPage = new Map<string, unknown>();
            return {
                ...hooks,
                response: (request, response) => {
                    if (!is(request, 'GET', /^\/agents$/)) return Promise.resolve(response);
                    const cursor = new URL(request.url).searchParams.get('cursor');
                    return editJson(response, (page) => {
                        const items = page['items'] as unknown[];
                        if (typeof page['nextCursor'] === 'string') lastOfPage.set(page['nextCursor'], items.at(-1));
                        const repeated = cursor === null ? undefined : lastOfPage.get(cursor);
                        return repeated === undefined ? page : { ...page, items: [repeated, ...items] };
                    });
                },
            };
        }
        case 'missing-audit-entry':
            return {
                ...hooks,
                response: (request, response) =>
                    editAudit(request, response, (entries) =>
                        entries.filter(({ action }) => action !== 'secret.revoke'),
                    ),
            };
        case 'wrong-audit-member':
            return {
                ...hooks,
                response: (request, response) =>
                    editAudit(request, response, (entries) =>
                        entries.map((entry) =>
                            entry['action'] === 'agent.create'
                                ? { ...entry, actor: { kind: 'member', memberId: 'member-someone-else' } }
                                : entry,
                        ),
                    ),
            };
        case 'wrong-problem-content-type':
            return {
                ...hooks,
                response: async (_, response) =>
                    response.status === 404
                        ? new Response(await response.text(), {
                              status: 404,
                              headers: { 'content-type': 'application/json' },
                          })
                        : response,
            };
    }
}
