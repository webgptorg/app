import { EngineVersion, Hostname, RelayId } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createMemoryIdentityStore } from '../adapters/memory-identity-store';
import { createMemoryRegistrationStore } from '../testing/memory-registration-store';
import { createFakeClock } from '../testing/fake-clock';
import { createFakeDashboard } from '../testing/fake-dashboard';
import { createMemoryLogger } from '../testing/memory-logger';
import { DEFAULT_MOCK_SETTINGS } from '../testing/mock-settings';
import type { MockEngineConfig } from './config';
import { ConfigError } from './config';
import {
    REGISTER_USAGE,
    RegisterUsageError,
    isRegistered,
    parseRegisterCommand,
    runRegisterCommand,
} from './register-command';

const ENGINE_DOMAIN = Hostname.parse('engines.ptbk.test');
const RELAYS = [Hostname.parse('relay-a.ptbk.test')];
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
    logLevel: 'info',
    ...DEFAULT_MOCK_SETTINGS,
    dashboard: { url: 'https://app.ptbk.test', linkCode: null, heartbeatIntervalS: 60, relaysOverride: false },
};

describe('parseRegisterCommand', () => {
    it('takes exactly --link and a link code', () => {
        const code = 'abcdefghijklmnopqrstuvwxya';
        expect(parseRegisterCommand(['--link', code])).toEqual({ linkCode: code });
        for (const args of [[], ['--link'], ['--code', code], ['--link', code, 'extra']]) {
            expect(() => parseRegisterCommand(args)).toThrow(new RegisterUsageError(REGISTER_USAGE));
        }
    });

    it('refuses a malformed code without echoing it', () => {
        let message = '';
        try {
            parseRegisterCommand(['--link', 'almost-a-secret-code']);
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toBe('--link must be a link code');
    });
});

describe('runRegisterCommand', () => {
    function setup() {
        const dashboard = createFakeDashboard({
            clock: createFakeClock(),
            engineDomain: ENGINE_DOMAIN,
            relays: RELAYS,
        });
        const deps = {
            identityStore: createMemoryIdentityStore(),
            registrations: createMemoryRegistrationStore(),
            api: dashboard.api,
            logger: createMemoryLogger(),
        };
        return { dashboard, deps };
    }

    it('reports registered, then already-registered', async () => {
        const { dashboard, deps } = setup();
        const identity = await deps.identityStore.loadOrCreate();
        const first = await runRegisterCommand({ linkCode: dashboard.issueLinkCode('org-a') }, CONFIG, deps);
        expect(first).toEqual({
            outcome: 'registered',
            engineId: identity.engineId,
            hostname: `${identity.engineId}.engines.ptbk.test`,
            relays: RELAYS,
        });
        expect(isRegistered(first)).toBe(true);
        const second = await runRegisterCommand({ linkCode: dashboard.issueLinkCode('org-a') }, CONFIG, deps);
        expect(second.outcome).toBe('already-registered');
        expect(isRegistered(second)).toBe(true);
    });

    it('reports a rejection and an unreachable dashboard', async () => {
        const { dashboard, deps } = setup();
        const code = dashboard.issueLinkCode('org-a');
        dashboard.setEngineLimit('org-a', 0);
        const rejected = await runRegisterCommand({ linkCode: code }, CONFIG, deps);
        expect(rejected).toEqual({ outcome: 'rejected', reason: 'engine-limit' });
        expect(isRegistered(rejected)).toBe(false);
        dashboard.unreachable = true;
        expect(await runRegisterCommand({ linkCode: code }, CONFIG, deps)).toEqual({ outcome: 'unavailable' });
    });

    it('needs PTBK_DASHBOARD_URL', async () => {
        const { dashboard, deps } = setup();
        await expect(
            runRegisterCommand({ linkCode: dashboard.issueLinkCode('org-a') }, { ...CONFIG, dashboard: null }, deps),
        ).rejects.toThrow(ConfigError);
    });
});
