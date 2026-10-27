import { createHash, X509Certificate } from 'node:crypto';

import type { Browser, Page } from '@playwright/test';
import { chromium, expect, test } from '@playwright/test';
import { EngineVersion, Hostname, RelayId, createCryptoRandom, defaultHostname } from '@ptbk/protocol';

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

interface Stack {
    readonly engine: MockEngine;
    readonly relay: FakeRelay;
    readonly passthrough: FakePassthrough;
    readonly logger: MemoryLogger;
    readonly linkCode: string;
    readonly hostname: string;
    /** The certificate's SPKI hash, which Chromium is told to trust: WebAuthn refuses pages with TLS errors. */
    readonly spki: string;
}

/**
 * The whole onboarding path in one process: the engine registers with a link code, dials the in-test relay, and is
 * reached through the relay's SNI passthrough by a real Chromium, exactly as through a production relay.
 */
async function startStack(): Promise<Stack> {
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
        passkeys: 'none',
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
    browser = await chromium.launch({
        args: [
            `--host-resolver-rules=MAP ${hostname} 127.0.0.1`,
            `--ignore-certificate-errors-spki-list=${stack.spki}`,
        ],
    });
    const context = await browser.newContext({ locale: 'en-GB' });
    const page = await context.newPage();
    const violations = watchPolicy(page);
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
    expect(engine.operator.status().ownerSetUp).toBe(true);
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
            body: `<a id="root" href="${origin}/">Open engine</a><a id="hostile" href="${origin}/auth/sign-in?next=%2F%2Fevil.example">Hostile</a>`,
        }),
    );
    await arrival.goto(`${OTHER_SITE}/`);
    await arrival.click('#root');
    await arrival.waitForURL(`${origin}/`);
    expect(arrivalPaths).toEqual(expect.arrayContaining(['/auth/sign-in', '/api/v1/me']));
    expect(await meStatus(arrival)).toBe(200);
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
    await page.goto(`${origin}/auth/sign-in?next=%2Fagents`);
    await page.locator('button[data-action="confirm"]').click();
    await page.waitForURL(`${origin}/agents`);
    expect(await meStatus(page)).toBe(200);

    expect(violations).toEqual([]);
    // A full onboarding run: registration, tunnel, setup link, passkey, sign-in. Nothing secret reached the log.
    const logs = stack.logger.text();
    for (const secretText of [secret, stack.linkCode, 'PRIVATE KEY']) expect(logs).not.toContain(secretText);
    expect(stack.logger.entries.map(({ event }) => event)).toEqual(
        expect.arrayContaining(['engine.identity', 'owner.none', 'engine.ready', 'setup-link.issued', 'owner.set-up']),
    );
});
