import type { LinkCode } from '@ptbk/protocol';
import { EngineVersion, Hostname } from '@ptbk/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { createDevCa, createDevCaCertificateSource } from '../src/adapters/dev-ca';
import { loadGatewayPageFiles } from '../src/adapters/http/gateway-page-files';
import { createMemoryIdentityStore } from '../src/adapters/memory-identity-store';
import type { MockEngineConfig } from '../src/app/config';
import { OPENED_IN_BROWSER } from '../src/app/setup-link-command';
import type { DashboardDeps, MockEngine, MockEngineDeps } from '../src/app/start-mock-engine';
import { startMockEngine } from '../src/app/start-mock-engine';
import { createInMemoryPasskeyStore } from '../src/domain/gateway/passkey-gateway';
import { createInMemorySetupSecretStore } from '../src/domain/onboarding/setup-secret';
import { registerEngine } from '../src/domain/registration/register';
import { oneTimeSecret } from '../src/domain/secret';
import type { FakeClock } from '../src/testing/fake-clock';
import { createFakeClock } from '../src/testing/fake-clock';
import type { FakeDashboard } from '../src/testing/fake-dashboard';
import { createFakeDashboard } from '../src/testing/fake-dashboard';
import type { FakeConnection, FakeDialer } from '../src/testing/fake-dialer';
import { createFakeDialer, flush, until } from '../src/testing/fake-dialer';
import type { MemoryLogger } from '../src/testing/memory-logger';
import { createMemoryLogger } from '../src/testing/memory-logger';
import { createMemoryRegistrationStore } from '../src/testing/memory-registration-store';
import { createMemorySeqStore } from '../src/testing/memory-seq-store';
import { DEFAULT_MOCK_SETTINGS } from '../src/testing/mock-settings';
import { completeHandshake } from '../src/testing/relay-handshake';
import { createSeededRandom } from '../src/testing/seeded-random';

const ENGINE_DOMAIN = Hostname.parse('engines.ptbk.test');
const DASHBOARD_URL = 'https://app.ptbk.test';
const SETUP_LINK = /^ {2}(https:\/\/[a-z0-9]+\.engines\.ptbk\.test\/setup#[A-Za-z0-9_-]{22})$/;

function config(linkCode: LinkCode | null, passkeys: 'seeded' | 'none'): MockEngineConfig {
    return {
        mode: 'tunnel',
        dataDir: '/unused',
        relays: [],
        engineDomain: ENGINE_DOMAIN,
        engineVersion: EngineVersion.parse('0.1.0'),
        proxy: null,
        extraCaFile: null,
        devCaFiles: null,
        devCaDomains: [],
        certificateSource: { kind: 'dev-ca' },
        logLevel: 'info',
        ...DEFAULT_MOCK_SETTINGS,
        passkeys,
        dashboard: {
            url: DASHBOARD_URL,
            linkCode: linkCode === null ? null : oneTimeSecret(linkCode),
            heartbeatIntervalS: 60,
        },
    };
}

interface Started {
    readonly engine: MockEngine;
    readonly dialer: FakeDialer;
    readonly dashboard: FakeDashboard;
    readonly dashboardDeps: DashboardDeps;
    readonly logger: MemoryLogger;
    readonly clock: FakeClock;
    readonly lines: string[];
    readonly opened: string[];
}

const engines: { engine: MockEngine; connections: FakeConnection[] }[] = [];
afterEach(async () => {
    for (const { engine, connections } of engines.splice(0)) {
        const closing = engine.close();
        for (const connection of connections) {
            await until(() => connection.closeCodes.length > 0);
            connection.relayClose(1001);
        }
        await closing;
    }
});

/** The engine as `node dist/main.mjs` runs it in the foreground: a terminal, and the first setup link to show. */
async function start(options: {
    readonly linked: boolean;
    readonly passkeys: 'seeded' | 'none';
    readonly terminal?: boolean;
    readonly mayOpen?: boolean;
    readonly hyperlinks?: boolean;
}): Promise<Started> {
    const clock = createFakeClock(Date.parse('2026-10-20T10:00:00Z'));
    const logger = createMemoryLogger();
    const dashboard = createFakeDashboard({
        clock,
        engineDomain: ENGINE_DOMAIN,
        relays: [Hostname.parse('relay-x.ptbk.test')],
    });
    const dashboardDeps: DashboardDeps = {
        api: dashboard.api,
        registrations: createMemoryRegistrationStore(),
        seqs: createMemorySeqStore(clock),
        systemStats: { sample: () => Promise.resolve({ diskPct: 40, ramPct: 50, cpuLoad: 'low' as const }) },
    };
    const dialer = createFakeDialer();
    const lines: string[] = [];
    const opened: string[] = [];
    const deps: MockEngineDeps = {
        logger,
        clock,
        random: createSeededRandom(1),
        identityStore: createMemoryIdentityStore(),
        dialer,
        certificates: createDevCaCertificateSource({ ca: createDevCa([ENGINE_DOMAIN], clock), clock, logger }),
        dashboard: dashboardDeps,
        onboarding: {
            setupSecrets: createInMemorySetupSecretStore(),
            passkeys: createInMemoryPasskeyStore(),
            pages: await loadGatewayPageFiles(),
        },
        say: options.terminal === false ? null : (line) => lines.push(line),
        firstSetupLink: {
            mayOpen: options.mayOpen ?? true,
            hyperlinks: options.hyperlinks ?? false,
            openBrowser: (url) => {
                opened.push(url);
                return Promise.resolve(true);
            },
        },
    };
    const engine = await startMockEngine(
        config(options.linked ? dashboard.issueLinkCode('org-a') : null, options.passkeys),
        deps,
    );
    engines.push({ engine, connections: [] });
    return { engine, dialer, dashboard, dashboardDeps, logger, clock, lines, opened };
}

/** The relay takes the tunnel: with the certificate and the setup page in place, the address works. */
async function reachable(started: Started): Promise<void> {
    const { connection } = await completeHandshake(started.dialer.dials[0], [started.engine.hostname]);
    engines.find(({ engine }) => engine === started.engine)?.connections.push(connection);
    await until(() => started.engine.operator.status().addressGaps.length === 0);
    await flush(5);
}

function linkIn(lines: readonly string[]): string | undefined {
    return lines.map((line) => SETUP_LINK.exec(line)?.[1]).find((url) => url !== undefined);
}

describe('the first setup link, shown by the engine in the foreground', () => {
    it('prints the link after Ready and opens it, once, without the secret reaching the log', async () => {
        const started = await start({ linked: true, passkeys: 'none' });
        await reachable(started);
        await until(() => started.opened.length > 0);
        const url = linkIn(started.lines);
        expect(url).toBeDefined();
        expect(started.opened).toEqual([url]);
        expect(started.lines.indexOf(`Ready: https://${started.engine.hostname}/`)).toBeLessThan(
            started.lines.indexOf(`  ${url ?? ''}`),
        );
        expect(started.lines.at(-1)).toBe(OPENED_IN_BROWSER);
        expect(started.lines.join('\n')).not.toContain('Run `mock-engine setup-link`');
        expect(started.logger.entries.filter(({ event }) => event === 'setup-link.issued')).toHaveLength(1);
        expect(started.logger.text()).not.toContain(url?.split('#')[1] ?? 'secret');
    });

    it('prints without opening where the session may not open a browser', async () => {
        const started = await start({ linked: true, passkeys: 'none', mayOpen: false });
        await reachable(started);
        await until(() => linkIn(started.lines) !== undefined);
        await flush(5);
        expect(started.opened).toEqual([]);
        expect(started.lines).not.toContain(OPENED_IN_BROWSER);
    });

    it('prints the link as a clickable OSC 8 hyperlink in a terminal that renders them', async () => {
        const started = await start({ linked: true, passkeys: 'none', hyperlinks: true });
        await reachable(started);
        await until(() => started.opened.length > 0);
        const [url] = started.opened;
        expect(started.lines).toContain(`  \u001b]8;;${url ?? ''}\u001b\\${url ?? ''}\u001b]8;;\u001b\\`);
    });

    it('issues nothing as a service, whose stdout is a log stream', async () => {
        const started = await start({ linked: true, passkeys: 'none', terminal: false });
        await reachable(started);
        expect(started.opened).toEqual([]);
        expect(started.logger.entries.map(({ event }) => event)).not.toContain('setup-link.issued');
        expect(started.logger.entries.map(({ event }) => event)).toContain('owner.none');
    });

    it('issues nothing for an engine that already has an owner', async () => {
        const started = await start({ linked: true, passkeys: 'seeded' });
        await reachable(started);
        expect(started.opened).toEqual([]);
        expect(linkIn(started.lines)).toBeUndefined();
        expect(started.lines).toContain('✓ Owner set up');
    });

    it('leaves the link to a connect on a terminal that brings it online, so only one secret is issued', async () => {
        const started = await start({ linked: false, passkeys: 'none' });
        await registerEngine({
            store: started.dashboardDeps.registrations,
            identity: started.engine.identity,
            dashboardUrl: DASHBOARD_URL,
            engineDomain: ENGINE_DOMAIN,
            api: started.dashboardDeps.api,
            engineVersion: EngineVersion.parse('0.1.0'),
            linkCode: started.dashboard.issueLinkCode('org-a'),
            logger: started.logger,
            signal: AbortSignal.timeout(5_000),
        });
        expect(await started.engine.operator.link({ callerShowsSetupLink: true })).toEqual({
            outcome: 'linked',
            relays: 1,
        });
        await reachable(started);
        expect(started.logger.entries.map(({ event }) => event)).not.toContain('setup-link.issued');
        expect(started.opened).toEqual([]);
        expect(started.lines).toContain(
            'No owner yet. `mock-engine connect` shows the setup link where it runs; `mock-engine setup-link` makes a new one.',
        );
        const shownByConnect = await started.engine.operator.setupLink();
        expect(shownByConnect.outcome).toBe('created');
    });

    it('still shows the link itself when connect runs without a terminal', async () => {
        const started = await start({ linked: false, passkeys: 'none' });
        await registerEngine({
            store: started.dashboardDeps.registrations,
            identity: started.engine.identity,
            dashboardUrl: DASHBOARD_URL,
            engineDomain: ENGINE_DOMAIN,
            api: started.dashboardDeps.api,
            engineVersion: EngineVersion.parse('0.1.0'),
            linkCode: started.dashboard.issueLinkCode('org-a'),
            logger: started.logger,
            signal: AbortSignal.timeout(5_000),
        });
        await started.engine.operator.link({ callerShowsSetupLink: false });
        await reachable(started);
        await until(() => started.opened.length > 0);
        expect(started.opened).toEqual([linkIn(started.lines)]);
    });
});
