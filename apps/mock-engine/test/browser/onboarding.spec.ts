import { createHash, X509Certificate } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { Browser, BrowserContext, Page } from '@playwright/test';
import { chromium, expect, test } from '@playwright/test';
import type { Member } from '@ptbk/engine-api';
import { PERMISSIONS, createEngineApiClient } from '@ptbk/engine-api';
import type { Signer } from '@ptbk/protocol';
import {
    EngineVersion,
    Heartbeat,
    Hostname,
    RelayId,
    Timestamp,
    createCryptoRandom,
    createWebCryptoSigner,
    defaultHostname,
    ed25519PublicKeyFromBytes,
    generateEd25519KeyPair,
    signAccessTicket,
} from '@ptbk/protocol';

import { createDevCa, createDevCaCertificateSource } from '../../src/adapters/dev-ca';
import { loadGatewayPageFiles } from '../../src/adapters/http/gateway-page-files';
import { createMemoryIdentityStore } from '../../src/adapters/memory-identity-store';
import { systemClock } from '../../src/adapters/system-clock';
import { createWsRelayDialer } from '../../src/adapters/ws-relay-dialer';
import type { MockEngineConfig } from '../../src/app/config';
import type { MockEngine } from '../../src/app/start-mock-engine';
import { startMockEngine } from '../../src/app/start-mock-engine';
import { createInMemoryPasskeyStore } from '../../src/domain/gateway/passkey-gateway';
import { createInMemorySetupSecretStore } from '../../src/domain/onboarding/setup-secret';
import { oneTimeSecret } from '../../src/domain/secret';
import type { FakeDashboard } from '../../src/testing/fake-dashboard';
import { createFakeDashboard } from '../../src/testing/fake-dashboard';
import type { FakePassthrough } from '../../src/testing/fake-passthrough';
import { startFakePassthrough } from '../../src/testing/fake-passthrough';
import type { FakeRelay } from '../../src/testing/fake-relay';
import { startFakeRelay } from '../../src/testing/fake-relay';
import type { MemoryLogger } from '../../src/testing/memory-logger';
import { createMemoryLogger } from '../../src/testing/memory-logger';
import { createMemorySeqStore } from '../../src/testing/memory-seq-store';
import { createMemoryRegistrationStore } from '../../src/testing/memory-registration-store';
import { DEFAULT_MOCK_SETTINGS } from '../../src/testing/mock-settings';
import { lookupLoopback, trackLinkStates } from '../../src/testing/test-hosts';
import { createTestCa } from '../../src/testing/test-pki';

const ENGINE_DOMAIN = Hostname.parse('engines.ptbk.test');
const RELAY = RelayId.parse('relay-a.ptbk.test');
const OTHER_SITE = 'https://dashboard.example';
const DEEP_LINK = '/agents/agent-deep-link?tab=chat&q=a%26b';

interface Stack {
    readonly engine: MockEngine;
    readonly relay: FakeRelay;
    readonly passthrough: FakePassthrough;
    readonly logger: MemoryLogger;
    readonly dashboard: FakeDashboard;
    readonly linkCode: string;
    readonly hostname: string;
    /** The certificate's SPKI hash, which Chromium is told to trust: WebAuthn refuses pages with TLS errors. */
    readonly spki: string;
}

interface StackOptions {
    /** `seeded` starts with the scenario's owner already set up; `none` waits for `/setup`. */
    readonly passkeys: 'none' | 'seeded';
    /** The dashboard's member key, pinned at registration, so the engine accepts its access tickets. */
    readonly memberKey?: Signer;
}

/**
 * The whole onboarding path in one process: the engine registers with a link code, dials the in-test relay, and is
 * reached through the relay's SNI passthrough by a real Chromium, exactly as through a production relay.
 */
async function startStack(options: StackOptions = { passkeys: 'none' }): Promise<Stack> {
    const relayCa = createTestCa('M-08 browser relay CA');
    const identityStore = createMemoryIdentityStore();
    const identity = await identityStore.loadOrCreate();
    const hostname = defaultHostname(identity.engineId, ENGINE_DOMAIN);
    const relay = await startFakeRelay({
        relayId: RELAY,
        tls: relayCa.issue([RELAY]),
        registry: (engineId) =>
            engineId === identity.engineId ? { publicKey: identity.publicKey, hostnames: [hostname] } : undefined,
    });
    const dashboard = createFakeDashboard({
        clock: systemClock,
        engineDomain: ENGINE_DOMAIN,
        relays: [Hostname.parse(RELAY)],
        ...(options.memberKey === undefined
            ? {}
            : { memberKey: ed25519PublicKeyFromBytes(options.memberKey.publicKey()) }),
    });
    const linkCode = dashboard.issueLinkCode('org-a');
    const logger = createMemoryLogger();
    const devCa = createDevCa([ENGINE_DOMAIN], systemClock);
    const certificates = createDevCaCertificateSource({ ca: devCa, clock: systemClock, logger });
    const states = trackLinkStates();
    const config: MockEngineConfig = {
        mode: 'tunnel',
        dataDir: '/unused',
        relays: [{ url: relay.url, relayId: RELAY, port: relay.port }],
        engineDomain: ENGINE_DOMAIN,
        engineVersion: EngineVersion.parse('0.1.0'),
        proxy: null,
        extraCaFile: null,
        devCaFiles: null,
        devCaDomains: [],
        certificateSource: { kind: 'dev-ca' },
        logLevel: 'info',
        ...DEFAULT_MOCK_SETTINGS,
        passkeys: options.passkeys,
        dashboard: { url: 'https://app.ptbk.test', linkCode: oneTimeSecret(linkCode), heartbeatIntervalS: 60 },
    };
    const engine = await startMockEngine(config, {
        logger,
        clock: systemClock,
        random: createCryptoRandom(),
        identityStore,
        dialer: createWsRelayDialer({ clock: systemClock, proxy: null, ca: [relayCa.certPem], lookup: lookupLoopback }),
        certificates,
        onLinkState: states.onLinkState,
        dashboard: {
            api: dashboard.api,
            registrations: createMemoryRegistrationStore(),
            seqs: createMemorySeqStore(systemClock),
            systemStats: { sample: () => Promise.resolve({ diskPct: 40, ramPct: 50, cpuLoad: 'low' as const }) },
        },
        onboarding: {
            setupSecrets: createInMemorySetupSecretStore(),
            passkeys: createInMemoryPasskeyStore(),
            pages: await loadGatewayPageFiles(),
        },
    });
    await states.next(RELAY, 'ready');
    const passthrough = await startFakePassthrough(await relay.waitForSession());
    const leaf = certificates.current(hostname)?.certificateChainPem.split(/(?=-----BEGIN CERTIFICATE-----)/)[0];
    if (leaf === undefined) throw new Error('no certificate for the engine');
    const spkiDer = new X509Certificate(leaf).publicKey.export({ type: 'spki', format: 'der' });
    return {
        engine,
        relay,
        passthrough,
        logger,
        dashboard,
        linkCode,
        hostname,
        spki: createHash('sha256').update(spkiDer).digest('base64'),
    };
}

/** The engine API's answer to the page's own cookie, from inside the page: only Chromium resolves the engine's name. */
function meStatus(page: Page): Promise<number> {
    return page.evaluate(async () => (await fetch('/api/v1/me', { credentials: 'same-origin' })).status);
}

/** Every CSP and Trusted Types refusal the page meets, as Chromium reports it on the console. */
function watchPolicy(page: Page): string[] {
    const violations: string[] = [];
    page.on('console', (message) => {
        if (/Content Security Policy|Trusted Type|Refused to (load|execute|apply)/i.test(message.text())) {
            violations.push(message.text());
        }
    });
    page.on('pageerror', (error) => violations.push(error.message));
    return violations;
}

/** Headless, and never near the login keychain or the profile's password store. */
function launch(current: Stack): Promise<Browser> {
    return chromium.launch({
        headless: true,
        args: [
            `--host-resolver-rules=MAP ${current.hostname} 127.0.0.1`,
            `--ignore-certificate-errors-spki-list=${current.spki}`,
            '--use-mock-keychain',
            '--password-store=basic',
        ],
    });
}

async function addVirtualAuthenticator(context: BrowserContext, page: Page): Promise<void> {
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
        },
    });
}

/** Only when asked for, so CI writes no files: `PTBK_SCREENSHOTS_DIR=<dir>`. */
async function screenshot(page: Page, name: string): Promise<void> {
    const directory = process.env['PTBK_SCREENSHOTS_DIR'];
    if (directory === undefined || directory === '') return;
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true, animations: 'disabled' });
}

const iso = (ms: number) => Timestamp.parse(new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'));

let stack: Stack | undefined;
let browser: Browser | undefined;

test.afterEach(async () => {
    await browser?.close();
    if (stack !== undefined) {
        // The relay closes its side, so the engine's going-away close completes.
        const closing = stack.engine.close();
        await stack.passthrough.close();
        await stack.relay.close();
        await closing;
    }
    stack = undefined;
    browser = undefined;
});

test('the owner sets up a passkey through /setup#<secret>, then signs in with it, under the engine CSP', async () => {
    stack = await startStack();
    const { engine, hostname, passthrough } = stack;
    browser = await launch(stack);
    const context = await browser.newContext({ locale: 'en-GB' });
    const page = await context.newPage();
    const violations = watchPolicy(page);
    await addVirtualAuthenticator(context, page);
    const origin = `https://${hostname}:${String(passthrough.port)}`;

    const link = await engine.operator.setupLink();
    if (link.outcome !== 'created') throw new Error(`no setup link: ${link.outcome}`);
    const secret = new URL(link.url).hash.slice(1);
    expect(engine.operator.status().ownerSetUp).toBe(false);

    await page.goto(`${origin}/setup#${secret}`);
    await expect(page.getByRole('heading', { name: 'Set up your engine' })).toBeVisible();
    // Read once, then gone from the address bar and the history entry.
    expect(new URL(page.url()).hash).toBe('');
    await expect(page.getByText(engine.identity.engineId, { exact: true })).toBeVisible();
    await page.locator('button[data-action="create"]').click();
    await expect(page.getByRole('heading', { name: 'You are the owner' })).toBeVisible();
    await expect(page.getByText('Setup is done.', { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open your engine' })).toBeVisible();
    expect(engine.operator.status().ownerSetUp).toBe(true);
    // The dashboard's tab waits on `members`: a beat goes out at once, well before the 60 s interval.
    const decoder = new TextDecoder();
    await expect
        .poll(
            () =>
                stack?.dashboard.heartbeats.some(
                    (beat) => Heartbeat.parse(JSON.parse(decoder.decode(beat.rawBody))).members > 0,
                ),
            { timeout: 10_000 },
        )
        .toBe(true);
    expect(await meStatus(page)).toBe(200);

    // The link is dead now, whoever opens it.
    const reused = await context.newPage();
    await reused.goto(`${origin}/setup#${secret}`);
    await expect(reused.getByRole('heading', { name: 'This engine already has an owner' })).toBeVisible();
    await reused.close();

    // A link from another site, like the dashboard's "Open engine": the Strict cookie stays behind, so the gateway
    // sends the owner to sign in, where the page's own request finds the session and goes on without a prompt.
    const arrival = await context.newPage();
    const arrivalViolations = watchPolicy(arrival);
    const arrivalPaths: string[] = [];
    arrival.on('request', (request) => arrivalPaths.push(new URL(request.url()).pathname));
    // Another site, answered by Playwright: the links are what the dashboard's "Open engine" is.
    await arrival.route(`${OTHER_SITE}/**`, (route) =>
        route.fulfill({
            contentType: 'text/html',
            body: `<a id="root" href="${origin}/">Open engine</a><a id="deep" href="${origin}${DEEP_LINK}#reply">Open agent</a><a id="hostile" href="${origin}/auth/sign-in?next=%2F%2Fevil.example">Hostile</a>`,
        }),
    );
    await arrival.goto(`${OTHER_SITE}/`);
    await arrival.click('#root');
    await arrival.waitForURL(`${origin}/`);
    expect(arrivalPaths).toEqual(expect.arrayContaining(['/auth/sign-in', '/api/v1/me']));
    expect(await meStatus(arrival)).toBe(200);
    // A deep link takes the same way round and still lands on its path and query; the server never sees the fragment.
    await arrival.goto(`${OTHER_SITE}/`);
    await arrival.click('#deep');
    await arrival.waitForURL(`${origin}${DEEP_LINK}`);
    await arrival.goto(`${OTHER_SITE}/`);
    await arrival.click('#hostile');
    await arrival.waitForURL(`${origin}/`);
    // `replace`: Back leaves the engine instead of returning to sign-in, which would forward again.
    await arrival.goBack();
    expect(arrival.url()).not.toContain('/auth/sign-in');
    expect(arrivalViolations).toEqual([]);
    await arrival.close();

    await context.clearCookies();
    expect(await meStatus(page)).toBe(401);
    // Signed out, a deep link is sent to sign in and, after the passkey, on to where it pointed.
    await page.goto(`${origin}${DEEP_LINK}`);
    await page.waitForURL(`${origin}/auth/sign-in?${new URLSearchParams({ next: DEEP_LINK }).toString()}`);
    await page.locator('button[data-action="confirm"]').click();
    await page.waitForURL(`${origin}${DEEP_LINK}`);
    expect(await meStatus(page)).toBe(200);

    expect(violations).toEqual([]);
    // A full onboarding run: registration, tunnel, setup link, passkey, sign-in. Nothing secret reached the log.
    const logs = stack.logger.text();
    for (const secretText of [secret, stack.linkCode, 'PRIVATE KEY', 'agent-deep-link']) {
        expect(logs).not.toContain(secretText);
    }
    expect(stack.logger.entries.map(({ event }) => event)).toEqual(
        expect.arrayContaining(['engine.identity', 'owner.none', 'engine.ready', 'setup-link.issued', 'owner.set-up']),
    );
});

test('an invited person joins with a ticket, reads out the code, and is signed in once approved, under the engine CSP', async () => {
    const memberKey = await createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
    stack = await startStack({ passkeys: 'seeded', memberKey });
    const { engine, hostname, passthrough } = stack;
    await expect.poll(() => engine.registration?.memberKey ?? null, { timeout: 10_000 }).not.toBeNull();
    browser = await launch(stack);
    const context = await browser.newContext({ locale: 'en-GB', viewport: { width: 720, height: 760 } });
    const page = await context.newPage();
    const violations = watchPolicy(page);
    await addVirtualAuthenticator(context, page);
    const origin = `https://${hostname}:${String(passthrough.port)}`;

    const issuedAt = Date.now();
    const ticket = await signAccessTicket(memberKey, {
        v: 1,
        engineId: engine.identity.engineId,
        ticketId: 'ticket-browser-000001',
        dashboardUserId: 'user-browser-jana',
        displayName: 'Jana Dvořák',
        email: 'jana@example.com',
        proposedRole: 'member',
        issuedAt: iso(issuedAt),
        expiresAt: iso(issuedAt + 15 * 60_000),
    });

    await page.goto(`${origin}/auth/join#${ticket}`);
    await expect(page.getByRole('heading', { name: `Join ${hostname}` })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
    await expect(
        page.getByText('This engine has its own secure address, so your browser asks for one more passkey here.'),
    ).toBeVisible();
    await screenshot(page, 'join');

    await page.locator('button[data-action="create"]').click();
    await expect(page.getByRole('heading', { name: 'Waiting for approval' })).toBeVisible();
    const shown = page.locator('[data-join-code]');
    await expect(shown).toHaveText(/^\d{3} \d{3}$/);
    await expect(page.getByText('Tell this code to the person approving you')).toBeVisible();
    await screenshot(page, 'waiting');
    const code = (await shown.textContent())?.replace(' ', '') ?? '';

    const controller = engine.runtime.controller();
    const owner = controller.inspect().members.find((member) => member.role === 'owner' && member.status === 'active');
    const [request] = controller.inspect().accessRequests;
    if (owner === undefined || request === undefined) throw new Error('no owner or no pending request');
    const ownerApi = createEngineApiClient(
        engine.runtime.core().transport({
            memberId: owner.id,
            sessionId: 'session-browser-owner' as never,
            client: { ip: '127.0.0.1', userAgent: 'browser test' },
            permissions: new Set(PERMISSIONS),
            stepUpFresh: true,
        }),
    );
    const approved = await ownerApi.members.approveAccessRequest(
        request.id,
        { code, role: 'member' },
        AbortSignal.timeout(10_000),
    );
    expect(approved.kind).toBe('ok');

    // The page's own status poll picks the approval up and signs in without another prompt.
    await page.waitForURL(`${origin}/`, { timeout: 15_000 });
    expect(await meStatus(page)).toBe(200);
    const joined: Member | undefined = controller
        .inspect()
        .members.find((member) => member.dashboardUserId === 'user-browser-jana');
    expect(joined?.status).toBe('active');
    expect(violations).toEqual([]);
    const logs = stack.logger.text();
    for (const secretText of [ticket, code]) expect(logs).not.toContain(secretText);
});
