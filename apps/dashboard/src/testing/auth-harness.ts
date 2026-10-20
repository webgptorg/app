import type { Hono } from 'hono';

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
import { DASHBOARD_POLICY } from '../domain/authz/policy';
import type { RateLimiter } from '../domain/ports/rate-limiter';
import type { RouteContract } from '../shared/api/contract';
import { createSoftwareAuthenticator, type SoftwareAuthenticator } from './software-authenticator';

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
}): AuthHarness {
    const clock = createFakeClock(START_MS);
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
        settle,
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
