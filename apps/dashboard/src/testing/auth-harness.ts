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
import type { AuthStore } from '../domain/auth/auth-store';
import { createAuthorizer } from '../domain/authz/authorizer';
import type { BillingStore } from '../domain/billing/billing-store';
import { DASHBOARD_POLICY } from '../domain/authz/policy';
import type { RateLimiter } from '../domain/ports/rate-limiter';
import type { RouteContract } from '../shared/api/contract';
import { syntheticWebhookSecret, TEST_PLANS } from './billing-fixtures';
import { createSoftwareAuthenticator, type SoftwareAuthenticator } from './software-authenticator';
import { stripeSignatureHeader } from './stripe-signature';
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
    route.output.parse(JSON.parse(text));
}

export function createAuthHarness(options: {
    readonly store: AuthStore;
    readonly rateLimiter?: (clock: FakeClock) => RateLimiter;
    readonly email?: 'fake' | 'cloudflare';
    /** Defaults to an in-memory store; the auth tests that use the default never touch billing. */
    readonly billingStore?: BillingStore;
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
        ADAPTERS: { email: options.email ?? 'fake', billing: 'fake', rateLimit: 'memory' },
        EMAIL_FROM: 'no-reply@ptbk.test',
        RATE_LIMIT_HMAC_KEY: DEV_RATE_LIMIT_HMAC_KEY,
        BILLING_PLANS: TEST_PLANS,
        STRIPE_WEBHOOK_SECRET: webhookSecret,
    });
    const testBilling = createTestBilling({
        clock,
        catalogue: config.plans,
        dashboardOrigin: ORIGIN,
        logger,
        webhookSecret,
        ...(options.billingStore === undefined ? {} : { store: options.billingStore }),
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
        rateLimiter: options.rateLimiter?.(clock) ?? createMemoryRateLimiter(clock),
        links: authLinks(ORIGIN),
        devOutbox: options.email === 'cloudflare' ? null : outbox,
        billing: testBilling.billing,
        entitlements: testBilling.entitlements,
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
        settle,
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
