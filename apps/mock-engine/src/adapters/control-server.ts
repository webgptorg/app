import {
    AgentId,
    BrowserHelpReason,
    BrowserOrigin,
    BrowserTabId,
    ChatId,
    LiveSessionId,
    MAX_BROWSER_HELP_MESSAGE_LENGTH,
    Permission,
    Role,
    TriggerId,
    WALLET_REQUEST_PROBLEMS,
    WalletOrigin,
} from '@ptbk/engine-api';
import { EngineVersion } from '@ptbk/protocol';
import { z } from 'zod';

import type { FaultPlan } from '../domain/faults/fault-plan';
import { FaultPlan as FaultPlanSchema, NO_FAULTS } from '../domain/faults/fault-plan';
import type { SessionStore } from '../domain/gateway/sessions';
import type { HeartbeatStatus } from '../domain/heartbeat/heartbeat-loop';
import { SESSION_COOKIE_NAME } from '../domain/gateway/sessions';
import type { Logger } from '../domain/logger';
import type { RateLimiter } from '../domain/rate-limit/rate-limiter';
import type { EngineRuntime } from '../domain/state/engine-runtime';
import { MAX_SIMULATION_SPEED, MIN_SIMULATION_SPEED } from '../domain/simulation/simulation-clock';
import { MockCapabilityName, capabilitiesFor } from '../domain/state/capabilities';
import { Scenario } from '../domain/state/scenarios';
import type { InstalledBundle } from '../domain/ui/bundle-store';
import type { UiLoader } from '../domain/ui/ui-loader';
import type { HttpRoute } from './http/route';
import { defineHttpRoute } from './http/route';
import { startPlainHttpServer } from './http/plain-http-server';
import { problemResponse } from './http/route-handler';

const NO_QUERY = z.strictObject({});
const BODY_MAX_BYTES = 16 * 1024;
const MAX_SEED = 2 ** 32 - 1;
/** One call advances at most a day, so a single request never blocks the engine for long. */
const MAX_ADVANCE_MS = 24 * 3600 * 1000;

const ScriptedRun = z.strictObject({
    agentId: AgentId,
    source: z.enum(['api', 'member', 'goal', 'webhook']).default('api'),
    outcome: z.enum(['completed', 'failed']),
    steps: z
        .array(
            z.strictObject({
                text: z.string().min(1).max(200),
                toolName: z
                    .string()
                    .regex(/^[a-z][a-z0-9_.-]{0,127}$/)
                    .optional(),
            }),
        )
        .min(1)
        .max(20),
});

const InboundEmail = z.strictObject({
    triggerId: TriggerId,
    from: z.email().max(254),
    subject: z.string().max(998),
});

/** What agent work asks the Wallet for when a login is missing or refused; the request text is the mock's. */
const WalletLoginRequest = z.strictObject({
    origin: WalletOrigin,
    account: z.string().min(1).max(320).nullable().default(null),
    problem: z.enum(WALLET_REQUEST_PROBLEMS).default('missing'),
});

/** What the provider answers a running harness sign-in with, as the core's `settleHarnessLogin` takes it. */
const HarnessLoginOutcome = z.strictObject({
    outcome: z.enum(['succeeded', 'failed', 'expired', 'denied']),
    diagnostic: z.string().min(1).max(2048).optional(),
});

const FailingHarnessCheck = z.strictObject({
    harness: z.enum(['codex', 'claude']),
    reason: z.string().min(1).max(2048),
});

const LiveBrowserTabRequest = z.strictObject({ origin: BrowserOrigin, chatId: ChatId.optional() });

/** What the agent in the tab says it is stuck on; without `tabId`, the fake agent tab the engine started with. */
const LiveBrowserHelpRequest = z.strictObject({
    tabId: BrowserTabId.optional(),
    reason: BrowserHelpReason,
    message: z.string().max(MAX_BROWSER_HELP_MESSAGE_LENGTH),
});

const LiveBrowserNavigation = z.strictObject({
    tabId: BrowserTabId,
    page: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('web'), origin: BrowserOrigin }),
        z.strictObject({ kind: z.literal('browser-page') }),
        z.strictObject({ kind: z.literal('secret-page') }),
    ]),
});

const LiveBrowserElapse = z.strictObject({ sessionId: LiveSessionId, what: z.enum(['expired', 'idle']) });

function invalidBody(path: string, message: string): Response {
    return problemResponse({ code: 'validation-failed', extras: { errors: [{ path, message }] } });
}

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
    /** The UI loader; absent without `PTBK_UI_RELEASE_URL`. */
    readonly ui?: UiLoader;
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

    /** The levers answer as the engine's own routes do while `MOCK_LIVE_BROWSER` is off. */
    const liveBrowser = (act: (tab: string) => Response): Response => {
        const tab = runtime.liveBrowserTab();
        return tab === null ? problemResponse({ code: 'capability-not-supported' }) : act(tab);
    };
    const knownTab = (tabId: string, act: () => Response): Response =>
        runtime.controller().getBrowserTab(tabId) === undefined ? problemResponse({ code: 'not-found' }) : act();

    const state = () => {
        const { seed, scenario, capabilities } = runtime.current();
        return {
            seed,
            scenario,
            capabilities: capabilities.map(({ id, version }) => `${id}@${String(version)}`),
            simulation: runtime.simulation().status(),
            counts: runtime.controller().inspect().counts,
        };
    };

    return [
        control({
            method: 'GET',
            path: '/__mock/state',
            body: null,
            handle: () => Response.json(state()),
        }),
        control({
            method: 'POST',
            path: '/__mock/reset',
            body: {
                kind: 'json',
                schema: z.strictObject({
                    scenario: Scenario,
                    seed: z.int().min(0).max(MAX_SEED),
                    capabilities: z.array(MockCapabilityName).max(MockCapabilityName.options.length).optional(),
                }),
                maxBytes: BODY_MAX_BYTES,
            },
            handle: async ({ body }) => {
                await runtime.reset({
                    seed: body.seed,
                    scenario: body.scenario,
                    ...(body.capabilities === undefined ? {} : { capabilities: capabilitiesFor(body.capabilities) }),
                });
                return Response.json(state());
            },
        }),
        control({
            method: 'POST',
            path: '/__mock/simulation',
            body: {
                kind: 'json',
                schema: z.strictObject({
                    mode: z.enum(['running', 'paused']),
                    speed: z.number().min(MIN_SIMULATION_SPEED).max(MAX_SIMULATION_SPEED).optional(),
                }),
                maxBytes: BODY_MAX_BYTES,
            },
            handle: ({ body }) => {
                runtime.clock.set(body.mode, body.speed);
                return Response.json(runtime.simulation().status());
            },
        }),
        control({
            method: 'POST',
            path: '/__mock/simulation/advance',
            body: {
                kind: 'json',
                schema: z.strictObject({ ms: z.int().min(1).max(MAX_ADVANCE_MS) }),
                maxBytes: BODY_MAX_BYTES,
            },
            handle: ({ body }) => {
                if (runtime.clock.mode() !== 'paused') return invalidBody('body', 'Pause the simulation first.');
                runtime.clock.advance(body.ms);
                return Response.json(runtime.simulation().status());
            },
        }),
        control({
            method: 'POST',
            path: '/__mock/runs',
            body: { kind: 'json', schema: ScriptedRun, maxBytes: BODY_MAX_BYTES },
            handle: ({ body }) => {
                const agent = runtime
                    .controller()
                    .findAgents()
                    .find(({ id }) => id === body.agentId);
                if (agent === undefined) return invalidBody('body.agentId', 'No such agent.');
                return Response.json(runtime.simulation().scriptRun(body), { status: 201 });
            },
        }),
        control({
            method: 'POST',
            path: '/__mock/wallet-requests',
            body: { kind: 'json', schema: WalletLoginRequest, maxBytes: BODY_MAX_BYTES },
            handle: ({ body }) => {
                const request = runtime.controller().requestWalletLogin({
                    ...body,
                    fields: [],
                    recordId: null,
                    reason: `An agent needs a login for ${new URL(body.origin).host}.`,
                    tasks: [],
                    agents: [],
                });
                return Response.json({ request }, { status: 201 });
            },
        }),
        control({
            method: 'POST',
            path: '/__mock/live-browser/tabs',
            body: { kind: 'json', schema: LiveBrowserTabRequest, maxBytes: BODY_MAX_BYTES },
            handle: ({ body }) =>
                liveBrowser(() => {
                    const tab = runtime.controller().openAgentTab({ origin: body.origin, chatId: body.chatId ?? null });
                    return Response.json({ tab }, { status: 201 });
                }),
        }),
        control({
            method: 'POST',
            path: '/__mock/live-browser/help-requests',
            body: { kind: 'json', schema: LiveBrowserHelpRequest, maxBytes: BODY_MAX_BYTES },
            handle: ({ body }) =>
                liveBrowser((startupTab) => {
                    const tabId = body.tabId ?? startupTab;
                    return knownTab(tabId, () => {
                        try {
                            const request = runtime
                                .controller()
                                .requestBrowserHelp(tabId, { reason: body.reason, message: body.message });
                            return Response.json({ request }, { status: 201 });
                        } catch {
                            // The core refuses only a sign-in tab here: no agent works in one to ask.
                            return invalidBody('body.tabId', 'Not an agent’s tab.');
                        }
                    });
                }),
        }),
        control({
            method: 'POST',
            path: '/__mock/live-browser/navigate',
            body: { kind: 'json', schema: LiveBrowserNavigation, maxBytes: BODY_MAX_BYTES },
            handle: ({ body }) =>
                liveBrowser(() =>
                    knownTab(body.tabId, () => {
                        runtime.controller().navigateBrowserTab(body.tabId, body.page);
                        return new Response(null, { status: 204 });
                    }),
                ),
        }),
        control({
            method: 'POST',
            path: '/__mock/live-browser/elapse',
            body: { kind: 'json', schema: LiveBrowserElapse, maxBytes: BODY_MAX_BYTES },
            handle: ({ body }) =>
                liveBrowser(() =>
                    runtime.controller().elapseBrowserSession(body.sessionId, body.what)
                        ? new Response(null, { status: 204 })
                        : problemResponse({ code: 'not-found' }),
                ),
        }),
        control({
            method: 'POST',
            path: '/__mock/inbound-email',
            body: { kind: 'json', schema: InboundEmail, maxBytes: BODY_MAX_BYTES },
            handle: ({ body }) => {
                // Like an engine, the subject becomes the run's preview; the sender is not stored. Neither is logged.
                const outcome = runtime.simulation().inboundEmail(body.triggerId, body.subject);
                switch (outcome.kind) {
                    case 'not-found':
                        return problemResponse({ code: 'not-found' });
                    case 'not-email':
                        return invalidBody('body.triggerId', 'Not an email trigger.');
                    case 'fired':
                        return Response.json({ fire: outcome.fire }, { status: 201 });
                }
            },
        }),
        control({
            method: 'POST',
            path: '/__mock/onboarding/harness-login',
            body: { kind: 'json', schema: HarnessLoginOutcome, maxBytes: BODY_MAX_BYTES },
            handle: ({ body }) => {
                const controller = runtime.controller();
                const login = controller.onboarding().prompt;
                if (login?.kind !== 'harness-login') return invalidBody('body', 'No harness sign-in is running.');
                controller.settleHarnessLogin(body.outcome, body.diagnostic);
                return Response.json(controller.onboarding());
            },
        }),
        control({
            method: 'POST',
            path: '/__mock/onboarding/harness-check',
            body: { kind: 'json', schema: FailingHarnessCheck, maxBytes: BODY_MAX_BYTES },
            handle: ({ body }) => {
                const controller = runtime.controller();
                controller.failHarnessCheck(body.harness, body.reason);
                return Response.json(controller.onboarding());
            },
        }),
        control({
            method: 'PUT',
            path: '/__mock/faults',
            body: { kind: 'json', schema: FaultPlanSchema, maxBytes: BODY_MAX_BYTES },
            handle: ({ body }) => {
                deps.faults.set(body);
                runtime.simulation().faultsChanged();
                return Response.json(body);
            },
        }),
        control({
            method: 'DELETE',
            path: '/__mock/faults',
            body: null,
            handle: () => {
                deps.faults.set(NO_FAULTS);
                runtime.simulation().faultsChanged();
                return new Response(null, { status: 204 });
            },
        }),
        control({
            method: 'GET',
            path: '/__mock/heartbeat',
            body: null,
            handle: () =>
                Response.json(deps.heartbeat?.() ?? { lastHeartbeat: null, clockSkew: null, lastAnswer: null }),
        }),
        control({
            method: 'GET',
            path: '/__mock/ui',
            body: null,
            handle: () => {
                if (deps.ui === undefined) return problemResponse({ code: 'not-found' });
                return Response.json(uiStatus(deps.ui));
            },
        }),
        control({
            method: 'POST',
            path: '/__mock/ui/check',
            body: {
                kind: 'json',
                schema: z.strictObject({ pinnedVersion: EngineVersion.optional() }),
                maxBytes: BODY_MAX_BYTES,
            },
            handle: async ({ body }) => {
                const { ui } = deps;
                if (ui === undefined) return problemResponse({ code: 'not-found' });
                if (body.pinnedVersion !== undefined && !ui.pin(body.pinnedVersion)) {
                    return problemResponse({
                        code: 'validation-failed',
                        extras: {
                            errors: [{ path: 'body.pinnedVersion', message: 'Only under PTBK_UPDATE_POLICY=pinned.' }],
                        },
                    });
                }
                const outcome = await ui.checkNow();
                return Response.json({ outcome, ...uiStatus(ui) });
            },
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
            path: '/__mock/step-up/expire',
            body: null,
            handle: () => {
                sessions.expireStepUps();
                return new Response(null, { status: 204 });
            },
        }),
        control({
            method: 'POST',
            path: '/__mock/sessions',
            body: {
                kind: 'json',
                schema: z.strictObject({
                    subject: SessionSubject,
                    // `stale`: signed in, but its passkey assertion too old for any step-up route.
                    stepUp: z.enum(['fresh', 'stale']).default('fresh'),
                }),
                maxBytes: BODY_MAX_BYTES,
            },
            handle: ({ body, clientIp }) => {
                const { memberId, permissions } = memberFor(body.subject);
                const signedIn = sessions.signIn({
                    memberId,
                    permissions,
                    stepUp: body.stepUp === 'stale' ? 'none' : 'fresh',
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

function bundleStatus(bundle: InstalledBundle | undefined) {
    return bundle === undefined ? null : { version: bundle.version, sha256: bundle.sha256, logIndex: bundle.logIndex };
}

/** What the loader serves and what its last check decided; never file contents. */
function uiStatus(ui: UiLoader) {
    return {
        policy: ui.policy(),
        active: bundleStatus(ui.store.active()),
        previous: bundleStatus(ui.store.previous()),
        lastOutcome: ui.lastOutcome(),
    };
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
    const server = await startPlainHttpServer({
        routes,
        rateLimiter: deps.rateLimiter,
        logger: deps.logger,
        errorEvent: 'control.error',
        listen: { host: deps.host, port: deps.port },
    });
    const port = server.port ?? deps.port;
    deps.logger.info('control.listening', { host: deps.host, port });
    return { port, routes, close: () => server.close() };
}
