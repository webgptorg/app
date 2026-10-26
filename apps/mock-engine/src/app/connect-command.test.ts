import { EngineVersion, Hostname, LinkCode, RelayId, deriveEngineFingerprint } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createMemoryIdentityStore } from '../adapters/memory-identity-store';
import type { DashboardApi, RegisterCall } from '../domain/dashboard/dashboard-api';
import type { LinkAnswer } from '../domain/onboarding/operator-api';
import { createFakeClock, settleWithClock } from '../testing/fake-clock';
import { createFakeDashboard } from '../testing/fake-dashboard';
import { createMemoryLogger } from '../testing/memory-logger';
import { createMemoryRegistrationStore } from '../testing/memory-registration-store';
import { DEFAULT_MOCK_SETTINGS } from '../testing/mock-settings';
import { createSeededRandom } from '../testing/seeded-random';
import type { MockEngineConfig } from './config';
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
const CONFIG: MockEngineConfig = {
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
    dashboard: { url: 'https://app.ptbk.test', linkCode: null, heartbeatIntervalS: 60 },
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
        expect(parseConnectCommand(['--link', CODE])).toEqual({ linkCode: CODE, json: false });
        expect(parseConnectCommand(['--json', '--link', CODE])).toEqual({ linkCode: CODE, json: true });
        expect(parseConnectCommand(['--link', CODE, '--json'])).toEqual({ linkCode: CODE, json: true });
        for (const args of [[], ['--link'], ['--json'], ['--link', CODE, '--link', CODE], ['--link', CODE, 'x']]) {
            expect(usageMessage(() => parseConnectCommand(args))).toBe(CONNECT_USAGE);
        }
    });

    it('refuses a malformed code without echoing it', () => {
        expect(usageMessage(() => parseConnectCommand(['--link', 'almost-a-secret-code']))).toBe(
            '--link must be a link code',
        );
    });
});

describe('parseRegisterCommand', () => {
    it('is connect with --json, under its X-05 usage', () => {
        expect(parseRegisterCommand(['--link', CODE])).toEqual({ linkCode: CODE, json: true });
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
        const deps = {
            identityStore: createMemoryIdentityStore(),
            registrations: createMemoryRegistrationStore(),
            api: dashboard.api,
            logger,
            clock,
            random: createSeededRandom(5),
            say: (line: string) => lines.push(line),
            signal: new AbortController().signal,
            joinRunning: () => Promise.resolve(running),
        };
        return {
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
        const first = await runConnectCommand({ linkCode: code, json: false }, CONFIG, deps);
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
            '✓ Linked to your Promptbook account',
            'Start the engine to bring it online; it uses this registration.',
        ]);
        const second = await runConnectCommand(
            { linkCode: dashboard.issueLinkCode('org-a'), json: false },
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
        await runConnectCommand({ linkCode: dashboard.issueLinkCode('org-a'), json: false }, CONFIG, deps);
        expect(lines.at(-1)).toBe('✓ The running engine is linked and connects to 2 relays');
        runEngine({ outcome: 'not-registered' });
        await runConnectCommand({ linkCode: dashboard.issueLinkCode('org-a'), json: false }, CONFIG, deps);
        expect(lines.at(-1)).toBe('✗ The running engine could not read this registration; restart it.');
        runEngine({ outcome: 'already-linked' });
        await runConnectCommand({ linkCode: dashboard.issueLinkCode('org-a'), json: false }, CONFIG, deps);
        expect(lines.at(-1)).toBe('✓ Already linked to your Promptbook account');
    });

    it('exits with the class of a refusal and says what to do', async () => {
        const { dashboard, deps, lines } = setup();
        dashboard.setEngineLimit('org-a', 0);
        const result = await runConnectCommand(
            { linkCode: dashboard.issueLinkCode('org-a'), json: true },
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
        const result = await runConnectCommand({ linkCode: LinkCode.parse(CODE), json: true }, CONFIG, {
            ...deps,
            api,
        });
        expect(result.exitCode).toBe(EXIT_CODE.linkCodeRefused);
        expect(calls).toEqual([
            { kind: 'problem', status: 401, problem: { code: 'invalid-link-code', serverTime: null } },
        ]);
    });

    it('retries an unreachable platform, telling the operator when, and exits 6 when the code cannot be valid', async () => {
        const { clock, dashboard, deps, lines } = setup();
        dashboard.unreachable = true;
        const result = await settleWithClock(
            runConnectCommand({ linkCode: dashboard.issueLinkCode('org-a'), json: true }, CONFIG, deps),
            clock,
        );
        expect(result).toEqual({
            exitCode: EXIT_CODE.unreachable,
            report: { outcome: 'unavailable', reason: 'no-answer' },
        });
        const retries = lines.filter((line) => line.startsWith('… Cannot reach the Promptbook platform (no answer)'));
        expect(retries.length).toBeGreaterThan(5);
        expect(lines.at(-1)).toMatch(
            /^✗ Cannot reach the Promptbook platform \(no answer\)\. The link code may have expired/,
        );
    });

    it('needs PTBK_DASHBOARD_URL', async () => {
        const { deps } = setup();
        await expect(
            runConnectCommand({ linkCode: LinkCode.parse(CODE), json: false }, { ...CONFIG, dashboard: null }, deps),
        ).rejects.toThrow(ConfigError);
    });
});
