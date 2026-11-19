import {
    ENGINE_API_PREFIX,
    ENGINE_RESERVED_PATHS,
    KNOWN_CAPABILITIES,
    OWNER_PERMISSIONS,
    SIGN_IN_PATH,
    createProblem,
} from '@ptbk/engine-api';
import type { CapabilityRef, Permission } from '@ptbk/engine-api';
import { createEngineApiHttpHandler } from '@ptbk/engine-api/http';
import { createDemoSeed, createInMemoryEngineCore } from '@ptbk/engine-api/in-memory';
import type { Actor, Authorizer, FileUploadPolicies, InMemoryEngineCore } from '@ptbk/engine-api/in-memory';
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
    'cancel-after-finish-accepted',
    'retry-from-completed-accepted',
    'non-idempotent-pause',
    'infected-file-downloadable',
    'wallet-seen-ends-request',
    'invalid-activity-item',
    'missing-permission-check-new-route',
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
    /** By default knowledge takes Markdown and plain text up to 1 KiB, so both upload policy refusals are exercised. */
    readonly uploadPolicies?: FileUploadPolicies;
}

const FAKE_UPLOAD_POLICIES: FileUploadPolicies = { knowledge: { maxBytes: 1024, accept: ['.md', 'text/plain'] } };

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
    // A schedule that already ended, so resuming one can be tried.
    const ended = {
        trigger: {
            id: 'trigger-fake-ended',
            agentId: 'agent-ada',
            name: 'Launch announcement',
            kind: 'schedule' as const,
            lifecycle: 'ended' as const,
            endedReason: 'completed' as const,
            lastFiredAt: at(120),
            nextFireAt: null,
            createdBy: OWNER,
            createdAt: at(600),
            updatedAt: at(120),
            config: {
                recurrence: { kind: 'once' as const, at: at(120) },
                startsAt: at(600),
                endsAt: null,
                maxRunCount: null,
                runCount: 1,
                message: 'Announce the launch.',
            },
        },
    };
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
            triggers: [...(demo.triggers ?? []), ended],
            // Mid-setup on an engine paired before its project, so the onboarding checks reach a prompt and a refused
            // "Skip for now".
            onboarding: 'no-project',
        },
        // Every capability, scanning included, so the suite's scan checks run against the fake too.
        capabilities: options.capabilities ?? Object.values(KNOWN_CAPABILITIES),
        uploadPolicies: options.uploadPolicies ?? FAKE_UPLOAD_POLICIES,
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

    const defect = createDefect(options.defect, actors, core);
    const answer = async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        if (!url.pathname.startsWith(`${ENGINE_API_PREFIX}/`)) {
            return request.method === 'GET' ? signInRedirect(url) : problem('not-found');
        }
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
            walletRequest: (origin) =>
                Promise.resolve(
                    core.controller.requestWalletLogin({
                        origin,
                        account: null,
                        problem: 'missing',
                        fields: [],
                        recordId: null,
                        reason: 'A conformance check needs a login.',
                        tasks: [],
                        agents: [],
                    }).id,
                ),
        },
    };
}

/** The fake has no UI, so every page needs a sign-in; a cruder `next` rule than the gateway's, enough for the checks. */
function signInRedirect(url: URL): Response {
    const target = `${url.pathname}${url.search}`;
    const safe =
        !target.startsWith('//') &&
        !target.includes('\\') &&
        !ENGINE_RESERVED_PATHS.some((prefix) => `${url.pathname}/`.startsWith(prefix));
    const location = safe ? `${SIGN_IN_PATH}?${new URLSearchParams({ next: target }).toString()}` : SIGN_IN_PATH;
    return new Response(null, { status: 303, headers: { location } });
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
function createDefect(
    defect: Defect | undefined,
    actors: ReadonlyMap<string, Actor>,
    core: InMemoryEngineCore,
): DefectHooks {
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
                    if (
                        is(request, 'POST', /^\/wallet\/records$/) ||
                        is(request, 'PUT', /^\/wallet\/records\/[^/]+$/)
                    ) {
                        const body = (await request.clone().json()) as { readonly password?: unknown };
                        if (typeof body.password === 'string') values.push(body.password);
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
                        entries.filter(({ action }) => action !== 'folder.rename'),
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
        case 'cancel-after-finish-accepted':
            return {
                ...hooks,
                response: (request, response) => {
                    const runId = /^\/runs\/([^/]+)\/cancel$/.exec(path(request))?.[1];
                    const run = core.controller.findRuns().find(({ id }) => id === runId);
                    if (request.method !== 'POST' || response.status !== 409 || run === undefined) {
                        return Promise.resolve(response);
                    }
                    return Promise.resolve(
                        Response.json({ ...run, cancelRequestedAt: run.completedAt }, { status: 202 }),
                    );
                },
            };
        case 'retry-from-completed-accepted':
            return {
                ...hooks,
                response: (request, response) => {
                    const runId = /^\/runs\/([^/]+)\/retry$/.exec(path(request))?.[1];
                    const run = runId === undefined ? undefined : core.controller.getRun(runId);
                    if (request.method !== 'POST' || response.status !== 409 || run === undefined) {
                        return Promise.resolve(response);
                    }
                    const retry = core.controller.startRun({ agentId: run.agentId, source: 'api', retryOf: run.id });
                    return Promise.resolve(Response.json(retry, { status: 201 }));
                },
            };
        case 'non-idempotent-pause':
            return {
                ...hooks,
                request(request) {
                    const triggerId = /^\/triggers\/([^/]+)\/pause$/.exec(path(request))?.[1];
                    const trigger = triggerId === undefined ? undefined : core.controller.getTrigger(triggerId);
                    if (request.method !== 'POST' || trigger?.lifecycle !== 'paused') return Promise.resolve(request);
                    // Pausing a paused trigger toggles it back on.
                    return Promise.resolve(new Request(request.url.replace(/\/pause$/, '/resume'), request));
                },
            };
        case 'infected-file-downloadable':
            return {
                ...hooks,
                response: (request, response) =>
                    Promise.resolve(
                        is(request, 'GET', /^\/files\/[^/]+\/content$/) && response.status === 409
                            ? new Response('MZ..', {
                                  headers: {
                                      'content-type': 'application/octet-stream',
                                      'content-disposition': 'attachment',
                                      'x-content-type-options': 'nosniff',
                                  },
                              })
                            : response,
                    ),
            };
        case 'wallet-seen-ends-request':
            return {
                ...hooks,
                response: (request, response) =>
                    is(request, 'GET', /^\/wallet$/)
                        ? editJson(response, (wallet) => ({
                              ...wallet,
                              pending: (wallet['pending'] as { readonly seenAt: unknown }[]).filter(
                                  ({ seenAt }) => seenAt === null,
                              ),
                          }))
                        : Promise.resolve(response),
            };
        case 'invalid-activity-item':
            return {
                ...hooks,
                response: (request, response) =>
                    is(request, 'GET', /^\/activity$/)
                        ? editJson(response, (page) => {
                              const items = page['items'] as Record<string, unknown>[];
                              const index = items.findIndex((item) => String(item['kind']).startsWith('run.'));
                              return {
                                  ...page,
                                  items: items.map((item, at) =>
                                      at === index ? { ...item, source: 'telepathy' } : item,
                                  ),
                              };
                          })
                        : Promise.resolve(response),
            };
        case 'missing-permission-check-new-route':
            return {
                ...hooks,
                actor: (request, actor) =>
                    is(request, 'POST', /^\/triggers\/[^/]+\/pause$/)
                        ? { ...actor, permissions: new Set([...actor.permissions, 'triggers.manage' as const]) }
                        : actor,
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
