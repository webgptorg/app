import { defaultHostname } from '@ptbk/protocol';
import type { Hono } from 'hono';

import type { FakeBillingState } from '../adapters/billing/fake-billing-provider';
import { createFakeClock, type FakeClock } from '../adapters/fake-clock';
import { createFakeEmailSender, type FakeEmailSender } from '../adapters/email/fake-email-sender';
import { createMemoryLogger, type MemoryLogger } from '../adapters/memory-logger';
import { createMemoryRateLimiter } from '../adapters/rate-limit/memory-rate-limiter';
import { cryptoRandom } from '../adapters/crypto-random';
import { createSimpleWebAuthnRelyingParty } from '../adapters/webauthn/simple-webauthn-relying-party';
import { parseConfig, DEV_RATE_LIMIT_HMAC_KEY } from '../app/config';
import { authLinks, type DashboardDeps } from '../app/deps';
import { createHttpApp } from '../app/http/create-http-app';
import { rateLimitRules } from '../app/rate-limiter';
import type { AuthStore } from '../domain/auth/auth-store';
import { createAuthorizer } from '../domain/authz/authorizer';
import type { BillingStore } from '../domain/billing/billing-store';
import type { CustomHostnameStore } from '../domain/custom-hostnames/custom-hostname-store';
import type { EngineStore } from '../domain/registration/engine-store';
import type { LinkCodeStore } from '../domain/registration/link-code-store';
import type { EngineHostnameStore } from '../domain/registry/engine-hostname-store';
import type { RegistryReader } from '../domain/registry/registry-reader';
import type { RelayTokenStore } from '../domain/registry/relay-token-store';
import { DASHBOARD_POLICY } from '../domain/authz/policy';
import type { RateLimiter } from '../domain/ports/rate-limiter';
import type { AlertRecipients } from '../domain/status/alert-recipients';
import type { HeartbeatTiming } from '../domain/status/engine-status';
import type { HeartbeatEngineReader } from '../domain/status/heartbeat-engine-reader';
import type { RouteContract } from '../shared/api/contract';
import { syntheticWebhookSecret, TEST_PLANS } from './billing-fixtures';
import { createSoftwareAuthenticator, type SoftwareAuthenticator } from './software-authenticator';
import { stripeSignatureHeader } from './stripe-signature';
import {
    createMemoryEngineStatuses,
    createMemoryHeartbeatEngineReader,
    type MemoryEngineStatuses,
} from './memory-engine-status';
import { createMemoryRegistrationStores } from './memory-registration-store';
import { createFakeDnsResolver, type FakeDnsResolver } from './fake-dns-resolver';
import { createMemoryCustomHostnameStore, type MemoryCustomHostnameStore } from './memory-custom-hostname-store';
import { createMemoryRegistryReader, createMemoryRelayTokenStore } from './memory-registry-stores';
import { createTestBilling } from './test-billing';

export const ORIGIN = 'https://app.ptbk.test';
export const START_MS = 1_800_000_000_000;

export interface TestResponse {
    readonly status: number;
    readonly body: unknown;
    readonly setCookies: readonly string[];
    readonly headers: Headers;
}

/** A browser on the dashboard origin: keeps cookies like a real one and sends same-origin Fetch Metadata. */
export interface TestBrowser {
    readonly cookies: Map<string, string>;
    readonly authenticator: SoftwareAuthenticator;
    request(
        method: string,
        path: string,
        body?: unknown,
        headers?: Readonly<Record<string, string>>,
    ): Promise<TestResponse>;
}

export interface AuthHarness {
    readonly http: Hono;
    readonly routes: readonly RouteContract[];
    readonly clock: FakeClock;
    readonly outbox: FakeEmailSender;
    readonly logger: MemoryLogger;
    readonly store: AuthStore;
    readonly deps: DashboardDeps;
    readonly billingStore: BillingStore;
    /** What the fake provider holds: customers, subscriptions, Checkout and portal sessions it was asked for. */
    readonly billingProvider: FakeBillingState;
    /** Generated per harness; the webhook route verifies with it. */
    readonly webhookSecret: string;
    /** In-memory custom hostnames; wired unless `customHostnames` was passed (the D1 store, in the workers project). */
    readonly engineHostnames: MemoryCustomHostnameStore;
    /** Every DNS check admins run goes here; unknown names answer `none`. */
    readonly dns: FakeDnsResolver;
    /** The engines' status objects, in process, with their alarms fired by hand. */
    readonly engineStatuses: MemoryEngineStatuses;
    /** Sends `body` exactly as given, for routes whose signature covers the raw bytes. */
    post(
        path: string,
        body: Uint8Array,
        headers?: Readonly<Record<string, string>>,
        options?: { readonly ip?: string },
    ): Promise<TestResponse>;
    /** Posts a Stripe webhook, signed with {@link webhookSecret} at the harness clock unless told otherwise. */
    webhook(
        payload: string,
        options?: { readonly signature?: string; readonly signedAtMs?: number; readonly secret?: string },
    ): Promise<TestResponse>;
    browser(options?: { readonly ip?: string; readonly authenticator?: SoftwareAuthenticator }): TestBrowser;
    /** Waits for everything handlers passed to `waitUntil`. */
    settle(): Promise<void>;
}

function matches(pattern: string, path: string): boolean {
    const want = pattern.split('/');
    const got = path.split('?')[0]?.split('/') ?? [];
    return want.length === got.length && want.every((part, index) => part.startsWith(':') || part === got[index]);
}

/** Outputs are strict schemas: a field the contract does not declare fails the test that caused it. */
function expectDeclaredOutput(routes: readonly RouteContract[], method: string, path: string, text: string): void {
    const route = routes.find((candidate) => candidate.method === method && matches(candidate.path, path));
    if (route === undefined) {
        throw new Error(`no route contract for ${method} ${path}`);
    }
    route.output.parse(text === '' ? undefined : JSON.parse(text));
}

export function createAuthHarness(options: {
    readonly store: AuthStore;
    readonly rateLimiter?: (clock: FakeClock) => RateLimiter;
    readonly email?: 'fake' | 'cloudflare';
    /** Defaults to an in-memory store; the auth tests that use the default never touch billing. */
    readonly billingStore?: BillingStore;
    /** Default to in-memory stores whose organizations always exist. */
    readonly registration?: { readonly linkCodes: LinkCodeStore; readonly engines: EngineStore };
    /** Default to in-memory ones; the registry reader then reads the registration stores' engines. */
    readonly relayTokens?: RelayTokenStore;
    readonly registry?: RegistryReader;
    /** Defaults to an in-memory store over the registration stores' engines and the auth store's audit log. */
    readonly customHostnames?: CustomHostnameStore & EngineHostnameStore;
    /** Defaults to a reader over the registration stores' engines. */
    readonly heartbeatEngines?: HeartbeatEngineReader;
    /** Defaults to nobody, for suites that never take an engine offline. */
    readonly alertRecipients?: AlertRecipients;
    /** The `HEARTBEAT` var; the config's defaults otherwise. */
    readonly heartbeat?: Partial<HeartbeatTiming>;
}): AuthHarness {
    const clock = createFakeClock(START_MS);
    const webhookSecret = syntheticWebhookSecret();
    const outbox = createFakeEmailSender();
    const logger = createMemoryLogger();
    const config = parseConfig({
        ENVIRONMENT: 'dev',
        DASHBOARD_ORIGIN: ORIGIN,
        ENGINE_DOMAIN: 'engines.ptbk.test',
        RELAYS: [{ relayId: 'relay-1.ptbk.test', region: 'eu-central' }],
        INSTALL_COMMAND: 'bun run dev:link {linkCode}',
        ADAPTERS: { email: options.email ?? 'fake', billing: 'fake', rateLimit: 'memory' },
        EMAIL_FROM: 'no-reply@ptbk.test',
        RATE_LIMIT_HMAC_KEY: DEV_RATE_LIMIT_HMAC_KEY,
        BILLING_PLANS: TEST_PLANS,
        STRIPE_WEBHOOK_SECRET: webhookSecret,
        ...(options.heartbeat === undefined ? {} : { HEARTBEAT: options.heartbeat }),
    });
    const testBilling = createTestBilling({
        clock,
        catalogue: config.plans,
        dashboardOrigin: ORIGIN,
        logger,
        webhookSecret,
        ...(options.billingStore === undefined ? {} : { store: options.billingStore }),
    });
    const registration = options.registration ?? createMemoryRegistrationStores({ orgExists: () => true });
    const engineHostnames = createMemoryCustomHostnameStore({
        engines: registration.engines,
        auditLog: options.store.adminAudit,
    });
    const dns = createFakeDnsResolver();
    const customHostnames = options.customHostnames ?? engineHostnames;
    const engineStatuses = createMemoryEngineStatuses({
        clock,
        logger,
        timing: config.heartbeat,
        recipients: options.alertRecipients ?? { forEngineOffline: () => Promise.resolve([]) },
        email: outbox,
        engineHostname: (engineId) => defaultHostname(engineId, config.engineDomain),
        engineLink: (engineId) => `${ORIGIN}/engines/${engineId}`,
    });
    const deps: DashboardDeps = {
        config,
        clock,
        random: cryptoRandom,
        logger,
        authorizer: createAuthorizer({ clock, policy: DASHBOARD_POLICY }),
        store: options.store,
        relyingParty: createSimpleWebAuthnRelyingParty({ origin: ORIGIN, rpName: 'Promptbook' }),
        email: outbox,
        rateLimiter: options.rateLimiter?.(clock) ?? createMemoryRateLimiter(clock, rateLimitRules(config)),
        links: authLinks(ORIGIN),
        devOutbox: options.email === 'cloudflare' ? null : outbox,
        billing: testBilling.billing,
        entitlements: testBilling.entitlements,
        linkCodes: registration.linkCodes,
        engines: registration.engines,
        relayTokens: options.relayTokens ?? createMemoryRelayTokenStore(),
        registry: options.registry ?? createMemoryRegistryReader(registration.engines),
        engineHostnames: customHostnames,
        customHostnames,
        dns,
        heartbeatEngines: options.heartbeatEngines ?? createMemoryHeartbeatEngineReader(registration.engines),
        engineStatus: engineStatuses,
    };
    const { app: http, routes } = createHttpApp({
        ...deps,
        assets: { fetch: () => Promise.resolve(new Response('<!doctype html>')) } as unknown as Fetcher,
        viteDevServer: false,
    });
    const pending: Promise<unknown>[] = [];
    const executionCtx = {
        waitUntil: (task: Promise<unknown>) => {
            pending.push(task);
        },
        passThroughOnException: () => undefined,
        props: {},
    } as unknown as ExecutionContext;

    async function settle(): Promise<void> {
        while (pending.length > 0) {
            await Promise.all(pending.splice(0));
        }
    }

    return {
        http,
        routes,
        clock,
        outbox,
        logger,
        store: options.store,
        deps,
        billingStore: testBilling.store,
        billingProvider: testBilling.provider,
        webhookSecret,
        engineHostnames,
        dns,
        engineStatuses,
        settle,
        async post(path, body, headers = {}, postOptions = {}) {
            const response = await http.request(
                `${ORIGIN}${path}`,
                {
                    method: 'POST',
                    headers: { 'CF-Connecting-IP': postOptions.ip ?? '198.51.100.20', ...headers },
                    body,
                },
                undefined,
                executionCtx,
            );
            const text = await response.text();
            await settle();
            if (response.ok) {
                expectDeclaredOutput(routes, 'POST', path, text);
            }
            return {
                status: response.status,
                body: text === '' ? null : (JSON.parse(text) as unknown),
                setCookies: [],
                headers: response.headers,
            };
        },
        async webhook(payload, webhookOptions = {}) {
            const signature =
                webhookOptions.signature ??
                (await stripeSignatureHeader(
                    payload,
                    webhookOptions.secret ?? webhookSecret,
                    webhookOptions.signedAtMs ?? clock.nowMs(),
                ));
            const response = await http.request(
                `${ORIGIN}/webhooks/stripe`,
                {
                    method: 'POST',
                    headers: { 'Stripe-Signature': signature, 'Content-Type': 'application/json' },
                    body: payload,
                },
                undefined,
                executionCtx,
            );
            const text = await response.text();
            if (response.ok) {
                expectDeclaredOutput(routes, 'POST', '/webhooks/stripe', text);
            }
            return {
                status: response.status,
                body: text === '' ? null : (JSON.parse(text) as unknown),
                setCookies: [],
                headers: response.headers,
            };
        },
        browser(browserOptions = {}) {
            const cookies = new Map<string, string>();
            return {
                cookies,
                authenticator: browserOptions.authenticator ?? createSoftwareAuthenticator({ origin: ORIGIN }),
                async request(method, path, body, headers = {}) {
                    const cookieHeader = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
                    const response = await http.request(
                        `${ORIGIN}${path}`,
                        {
                            method,
                            headers: {
                                'Sec-Fetch-Site': 'same-origin',
                                'CF-Connecting-IP': browserOptions.ip ?? '192.0.2.1',
                                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                                ...(cookieHeader === '' ? {} : { Cookie: cookieHeader }),
                                ...headers,
                            },
                            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                        },
                        undefined,
                        executionCtx,
                    );
                    const setCookies = response.headers.getSetCookie();
                    for (const cookie of setCookies) {
                        const [pair = '', ...attributes] = cookie.split('; ');
                        const separator = pair.indexOf('=');
                        const name = pair.slice(0, separator);
                        const value = pair.slice(separator + 1);
                        if (attributes.includes('Max-Age=0')) {
                            cookies.delete(name);
                        } else {
                            cookies.set(name, value);
                        }
                    }
                    const text = await response.text();
                    await settle();
                    if (response.ok) {
                        expectDeclaredOutput(routes, method, path, text);
                    }
                    return {
                        status: response.status,
                        body: text === '' ? null : (JSON.parse(text) as unknown),
                        setCookies,
                        headers: response.headers,
                    };
                },
            };
        },
    };
}
