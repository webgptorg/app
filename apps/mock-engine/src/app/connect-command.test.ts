import { EngineVersion, Hostname, LinkCode, RelayId, deriveEngineFingerprint } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createMemoryIdentityStore } from '../adapters/memory-identity-store';
import type { DashboardApi, RegisterCall } from '../domain/dashboard/dashboard-api';
import type { LinkAnswer, OperatorStatus, SetupLinkAnswer } from '../domain/onboarding/operator-api';
import { createFakeClock, settleWithClock } from '../testing/fake-clock';
import { createFakeDashboard } from '../testing/fake-dashboard';
import { createMemoryLogger } from '../testing/memory-logger';
import { createMemoryRegistrationStore } from '../testing/memory-registration-store';
import { DEFAULT_MOCK_SETTINGS } from '../testing/mock-settings';
import { createSeededRandom } from '../testing/seeded-random';
import type { ParsedMockEngineConfig } from './config';
import { ConfigError } from './config';
import {
    CONNECT_USAGE,
    ConnectUsageError,
    REGISTER_USAGE,
    parseConnectCommand,
    parseRegisterCommand,
    runConnectCommand,
} from './connect-command';
import { EXIT_CODE } from './exit-codes';

const ENGINE_DOMAIN = Hostname.parse('engines.ptbk.test');
const RELAYS = [Hostname.parse('relay-a.ptbk.test')];
const CODE = 'abcdefghijklmnopqrstuvwxya';
const DASHBOARD_URL = 'https://app.ptbk.test';
const SETUP_URL = 'https://k5dq4tabcdefghijklmnopqrst.engines.ptbk.test/setup#Zm9vYmFyYmF6cXV4cXV1eA';
const CONFIG: ParsedMockEngineConfig = {
    mode: 'tunnel',
    dataDir: '/unused',
    relays: [{ url: 'wss://relay-a.ptbk.test/v1/tunnel', relayId: RelayId.parse('relay-a.ptbk.test'), port: 443 }],
    engineDomain: ENGINE_DOMAIN,
    engineVersion: EngineVersion.parse('0.1.0'),
    proxy: null,
    extraCaFile: null,
    devCaFiles: null,
    devCaDomains: [],
    certificateSource: { kind: 'dev-ca' },
    logLevel: 'info',
    ...DEFAULT_MOCK_SETTINGS,
    dashboard: { url: DASHBOARD_URL, linkCode: null, heartbeatIntervalS: 60 },
};
/** No `PTBK_DASHBOARD_URL`: the link URL or the stored registration names the dashboard. */
const UNSET: ParsedMockEngineConfig = {
    ...CONFIG,
    relays: [],
    dashboard: { url: null, linkCode: null, heartbeatIntervalS: 60 },
};

function usageMessage(parse: () => unknown): string {
    try {
        parse();
    } catch (error) {
        if (error instanceof ConnectUsageError) return error.message;
        throw error;
    }
    throw new Error('parsed');
}

describe('parseConnectCommand', () => {
    it('takes --link with a code and an optional --json, in any order', () => {
        expect(parseConnectCommand(['--link', CODE])).toEqual({
            linkCode: CODE,
            dashboardOrigin: null,
            json: false,
            open: true,
        });
        expect(parseConnectCommand(['--json', '--link', CODE])).toEqual({
            linkCode: CODE,
            dashboardOrigin: null,
            json: true,
            open: true,
        });
        expect(parseConnectCommand(['--link', CODE, '--json'])).toEqual({
            linkCode: CODE,
            dashboardOrigin: null,
            json: true,
            open: true,
        });
        expect(parseConnectCommand(['--no-open', '--link', CODE])).toMatchObject({ open: false });
        for (const args of [
            [],
            ['--link'],
            ['--json'],
            ['--link', CODE, '--link', CODE],
            ['--link', CODE, 'x'],
            ['--link', CODE, '--no-open', '--no-open'],
        ]) {
            expect(usageMessage(() => parseConnectCommand(args))).toBe(CONNECT_USAGE);
        }
    });

    it('takes a link URL with its dashboard origin', () => {
        expect(parseConnectCommand(['--link', `https://app.ptbk.link/link#${CODE}`])).toEqual({
            linkCode: CODE,
            dashboardOrigin: 'https://app.ptbk.link',
            json: false,
            open: true,
        });
    });

    it.each([
        ['almost-a-secret-code', '--link must be the link URL the dashboard shows, or its link code'],
        [`http://app.ptbk.link/link#${CODE}`, '--link must be an https:// link URL'],
        [`https://secret@app.ptbk.link/link#${CODE}`, '--link must not contain a user name or password'],
        [`https://app.ptbk.link/engines#${CODE}`, "--link must be the dashboard's /link URL"],
        [`https://app.ptbk.link/link?x=1#${CODE}`, '--link must not have a query'],
        ['https://app.ptbk.link/link#almost-a-secret-code', '--link has no valid link code after #'],
    ])('refuses %s without echoing it', (value, message) => {
        expect(usageMessage(() => parseConnectCommand(['--link', value]))).toBe(message);
        expect(message).not.toContain('secret');
        expect(message).not.toContain(CODE);
    });
});

describe('parseRegisterCommand', () => {
    it('is connect with --json, under its X-05 usage', () => {
        expect(parseRegisterCommand(['--link', CODE])).toEqual({
            linkCode: CODE,
            dashboardOrigin: null,
            json: true,
            open: false,
        });
        for (const args of [[], ['--link'], ['--code', CODE], ['--link', CODE, '--json']]) {
            expect(usageMessage(() => parseRegisterCommand(args))).toBe(REGISTER_USAGE);
        }
    });
});

describe('runConnectCommand', () => {
    function setup() {
        const clock = createFakeClock(Date.parse('2026-10-26T10:00:00Z'));
        const dashboard = createFakeDashboard({ clock, engineDomain: ENGINE_DOMAIN, relays: RELAYS });
        const lines: string[] = [];
        const logger = createMemoryLogger();
        let running: LinkAnswer | null = null;
        const joins: boolean[] = [];
        const shown: string[] = [];
        const apiUrls: string[] = [];
        const deps = {
            identityStore: createMemoryIdentityStore(),
            registrations: createMemoryRegistrationStore(),
            api: (url: string) => {
                apiUrls.push(url);
                return dashboard.api;
            },
            logger,
            clock,
            random: createSeededRandom(5),
            say: (line: string) => lines.push(line),
            signal: new AbortController().signal,
            joinRunning: (showsSetupLink: boolean) => {
                joins.push(showsSetupLink);
                return Promise.resolve(running);
            },
            terminal: false,
            setupLink: {
                client: {
                    status: () => Promise.resolve({ ownerSetUp: false } as OperatorStatus),
                    setupLink: () =>
                        Promise.resolve<SetupLinkAnswer>({
                            outcome: 'created',
                            url: SETUP_URL,
                            expiresAt: '2026-10-26T10:30:00Z',
                        }),
                },
                out: (line: string) => shown.push(line),
                err: (line: string) => shown.push(line),
                sleep: () => Promise.resolve(),
                nowMs: () => 0,
                clockTime: () => '10:30',
                session: { platform: 'darwin', env: {} },
                openBrowser: (url: string) => {
                    shown.push(`opened ${url}`);
                    return Promise.resolve(true);
                },
            },
        };
        return {
            apiUrls,
            joins,
            shown,
            clock,
            dashboard,
            deps,
            lines,
            logger,
            runEngine: (answer: LinkAnswer | null) => {
                running = answer;
            },
        };
    }

    it('creates the key, links and shows the identity the dashboard shows, then reports already linked', async () => {
        const { dashboard, deps, lines } = setup();
        const code = dashboard.issueLinkCode('org-a');
        const first = await runConnectCommand(
            { linkCode: code, dashboardOrigin: null, json: false, open: true },
            CONFIG,
            deps,
        );
        const identity = await deps.identityStore.loadOrCreate();
        expect(first).toEqual({
            exitCode: EXIT_CODE.ok,
            report: {
                outcome: 'registered',
                engineId: identity.engineId,
                hostname: `${identity.engineId}.engines.ptbk.test`,
                relays: RELAYS,
            },
        });
        expect(lines).toEqual([
            '✓ Engine key ready',
            `        Engine ID     ${identity.engineId}`,
            `        Address       https://${identity.engineId}.engines.ptbk.test`,
            `        Fingerprint   ${deriveEngineFingerprint(identity.engineId).formatted}   (the dashboard shows the same)`,
            '… Linking with the Promptbook dashboard at https://app.ptbk.test',
            '✓ Linked to your Promptbook account',
            'Start the engine to bring it online; it uses this registration.',
        ]);
        const second = await runConnectCommand(
            { linkCode: dashboard.issueLinkCode('org-a'), dashboardOrigin: null, json: false, open: true },
            CONFIG,
            deps,
        );
        expect(second.report.outcome).toBe('already-registered');
        expect(lines.at(-2)).toBe('✓ Already linked to your Promptbook account');
        expect(lines.join('\n')).not.toContain(code);
    });

    it('hands the registration to an engine running unlinked', async () => {
        const { dashboard, deps, lines, runEngine } = setup();
        runEngine({ outcome: 'linked', relays: 2 });
        await runConnectCommand(
            { linkCode: dashboard.issueLinkCode('org-a'), dashboardOrigin: null, json: false, open: true },
            CONFIG,
            deps,
        );
        expect(lines.at(-1)).toBe('✓ The running engine is linked and connects to 2 relays');
        runEngine({ outcome: 'not-registered' });
        await runConnectCommand(
            { linkCode: dashboard.issueLinkCode('org-a'), dashboardOrigin: null, json: false, open: true },
            CONFIG,
            deps,
        );
        expect(lines.at(-1)).toBe('✗ The running engine could not read this registration; restart it.');
        runEngine({ outcome: 'already-linked' });
        await runConnectCommand(
            { linkCode: dashboard.issueLinkCode('org-a'), dashboardOrigin: null, json: false, open: true },
            CONFIG,
            deps,
        );
        expect(lines.at(-1)).toBe('✓ Already linked to your Promptbook account');
    });

    it('on a terminal, claims the first setup link from the engine it brings online, then shows and opens it', async () => {
        const { dashboard, deps, joins, shown, runEngine } = setup();
        runEngine({ outcome: 'linked', relays: 1 });
        const command = { linkCode: dashboard.issueLinkCode('org-a'), dashboardOrigin: null, json: false, open: true };
        const result = await runConnectCommand(command, CONFIG, { ...deps, terminal: true });
        expect(result.exitCode).toBe(EXIT_CODE.ok);
        expect(joins).toEqual([true]);
        expect(shown).toContain(`  ${SETUP_URL}`);
        expect(shown.slice(-2)).toEqual([`opened ${SETUP_URL}`, 'Opened in your browser. Create your passkey there.']);
    });

    it('leaves the setup link to the engine with --json or without a terminal, and opens nothing with --no-open', async () => {
        const { dashboard, deps, joins, shown, runEngine } = setup();
        runEngine({ outcome: 'linked', relays: 1 });
        const code = () => dashboard.issueLinkCode('org-a');
        await runConnectCommand({ linkCode: code(), dashboardOrigin: null, json: false, open: true }, CONFIG, deps);
        await runConnectCommand({ linkCode: code(), dashboardOrigin: null, json: true, open: true }, CONFIG, {
            ...deps,
            terminal: true,
        });
        expect(joins).toEqual([false, false]);
        expect(shown).toEqual([]);
        await runConnectCommand({ linkCode: code(), dashboardOrigin: null, json: false, open: false }, CONFIG, {
            ...deps,
            terminal: true,
        });
        expect(shown).toContain(`  ${SETUP_URL}`);
        expect(shown.some((line) => line.startsWith('opened'))).toBe(false);
    });

    it('shows no setup link for an engine that was linked already', async () => {
        const { dashboard, deps, shown, runEngine } = setup();
        runEngine({ outcome: 'already-linked' });
        const command = { linkCode: dashboard.issueLinkCode('org-a'), dashboardOrigin: null, json: false, open: true };
        await runConnectCommand(command, CONFIG, { ...deps, terminal: true });
        expect(shown).toEqual([]);
    });

    it('exits with the class of a refusal and says what to do', async () => {
        const { dashboard, deps, lines } = setup();
        dashboard.setEngineLimit('org-a', 0);
        const result = await runConnectCommand(
            { linkCode: dashboard.issueLinkCode('org-a'), dashboardOrigin: null, json: true, open: true },
            CONFIG,
            deps,
        );
        expect(result).toEqual({ exitCode: EXIT_CODE.plan, report: { outcome: 'rejected', reason: 'engine-limit' } });
        expect(lines.at(-1)).toBe(
            '✗ Your Promptbook plan does not allow another engine. Check Billing at app.ptbk.io.',
        );
    });

    it('answers 401 invalid-link-code for an unknown code, as the dashboard does', async () => {
        const { dashboard, deps } = setup();
        const calls: RegisterCall[] = [];
        const api: DashboardApi = {
            register: async (request, signal) => {
                const call = await dashboard.api.register(request, signal);
                calls.push(call);
                return call;
            },
            heartbeat: (...args) => dashboard.api.heartbeat(...args),
        };
        const result = await runConnectCommand(
            { linkCode: LinkCode.parse(CODE), dashboardOrigin: null, json: true, open: true },
            CONFIG,
            { ...deps, api: () => api },
        );
        expect(result.exitCode).toBe(EXIT_CODE.linkCodeRefused);
        expect(calls).toEqual([
            { kind: 'problem', status: 401, problem: { code: 'invalid-link-code', serverTime: null } },
        ]);
    });

    it('retries an unreachable platform, telling the operator when, and exits 6 when the code cannot be valid', async () => {
        const { clock, dashboard, deps, lines } = setup();
        dashboard.unreachable = true;
        const result = await settleWithClock(
            runConnectCommand(
                { linkCode: dashboard.issueLinkCode('org-a'), dashboardOrigin: null, json: true, open: true },
                CONFIG,
                deps,
            ),
            clock,
        );
        expect(result).toEqual({
            exitCode: EXIT_CODE.unreachable,
            report: { outcome: 'unavailable', reason: 'no-answer' },
        });
        const retries = lines.filter((line) => line.startsWith('… Cannot reach the Promptbook platform (no answer)'));
        expect(retries.length).toBeGreaterThan(5);
        expect(lines.at(-1)).toMatch(
            /^✗ Cannot reach the Promptbook platform \(no answer\)\. Check the network and any proxy/,
        );
    });

    it('links with the dashboard a link URL names, says so first, and stores it with the registration', async () => {
        const { apiUrls, dashboard, deps, lines } = setup();
        const linkCode = dashboard.issueLinkCode('org-a');
        const result = await runConnectCommand(
            { linkCode, dashboardOrigin: DASHBOARD_URL, json: false, open: true },
            UNSET,
            deps,
        );
        expect(result.exitCode).toBe(EXIT_CODE.ok);
        expect(apiUrls).toEqual([DASHBOARD_URL]);
        expect(lines.findIndex((line) => line.includes(`dashboard at ${DASHBOARD_URL}`))).toBeLessThan(
            lines.indexOf('✓ Linked to your Promptbook account'),
        );
        expect((await deps.registrations.load())?.dashboardUrl).toBe(DASHBOARD_URL);
        expect(lines.join('\n')).not.toContain(linkCode);
    });

    it('accepts a link URL for the dashboard PTBK_DASHBOARD_URL names', async () => {
        const { dashboard, deps } = setup();
        const result = await runConnectCommand(
            { linkCode: dashboard.issueLinkCode('org-a'), dashboardOrigin: DASHBOARD_URL, json: true, open: true },
            CONFIG,
            deps,
        );
        expect(result.report.outcome).toBe('registered');
    });

    it('refuses a link URL for another dashboard than PTBK_DASHBOARD_URL, before sending anything', async () => {
        const { apiUrls, dashboard, deps } = setup();
        const command = {
            linkCode: dashboard.issueLinkCode('org-a'),
            dashboardOrigin: 'https://app.ptbk.link',
            json: false,
            open: true,
        };
        await expect(runConnectCommand(command, CONFIG, deps)).rejects.toThrow(ConfigError);
        await expect(runConnectCommand(command, CONFIG, deps)).rejects.toMatchObject({
            problems: [
                'PTBK_DASHBOARD_URL: names https://app.ptbk.test, but the link URL is for https://app.ptbk.link; unset PTBK_DASHBOARD_URL or use a link from that dashboard',
            ],
        });
        expect(apiUrls).toEqual([]);
        expect(dashboard.registerRequests).toEqual([]);
    });

    it('sends a bare code to the dashboard stored with the registration', async () => {
        const { apiUrls, dashboard, deps } = setup();
        await runConnectCommand(
            { linkCode: dashboard.issueLinkCode('org-a'), dashboardOrigin: DASHBOARD_URL, json: true, open: true },
            UNSET,
            deps,
        );
        const again = await runConnectCommand(
            { linkCode: dashboard.issueLinkCode('org-a'), dashboardOrigin: null, json: true, open: true },
            UNSET,
            deps,
        );
        expect(again.report.outcome).toBe('already-registered');
        expect(apiUrls).toEqual([DASHBOARD_URL, DASHBOARD_URL]);
    });

    it('needs a link URL or PTBK_DASHBOARD_URL for a bare code on a new engine', async () => {
        const { deps } = setup();
        const command = { linkCode: LinkCode.parse(CODE), dashboardOrigin: null, json: false, open: true };
        await expect(runConnectCommand(command, UNSET, deps)).rejects.toThrow(ConfigError);
        await expect(runConnectCommand(command, { ...CONFIG, dashboard: null }, deps)).rejects.toThrow(ConfigError);
    });
});
