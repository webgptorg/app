import { EngineVersion, Hostname, LinkCode } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createMemoryIdentityStore } from '../adapters/memory-identity-store';
import { createMemoryRegistrationStore } from '../testing/memory-registration-store';
import { oneTimeSecret } from '../domain/secret';
import { createFakeClock, settleWithClock } from '../testing/fake-clock';
import { createFakeDashboard } from '../testing/fake-dashboard';
import { createMemoryLogger } from '../testing/memory-logger';
import { createSeededRandom } from '../testing/seeded-random';
import { EXIT_CODE } from './exit-codes';
import type { DashboardConfig } from './config';
import { describeOutcome, establishRegistration } from './establish-registration';

const ENGINE_DOMAIN = Hostname.parse('engines.ptbk.test');
const RELAYS = [Hostname.parse('relay-a.ptbk.test')];

async function setup() {
    const clock = createFakeClock();
    const dashboard = createFakeDashboard({ clock, engineDomain: ENGINE_DOMAIN, relays: RELAYS });
    const store = createMemoryRegistrationStore();
    const logger = createMemoryLogger();
    const identity = await createMemoryIdentityStore().loadOrCreate();
    const establish = (linkCode: DashboardConfig['linkCode']) =>
        establishRegistration({
            dashboard: { url: 'https://app.ptbk.test', linkCode, heartbeatIntervalS: 60 },
            engineDomain: ENGINE_DOMAIN,
            engineVersion: EngineVersion.parse('0.1.0'),
            identity,
            api: dashboard.api,
            store,
            logger,
            clock,
            random: createSeededRandom(2),
            signal: new AbortController().signal,
        });
    return { clock, dashboard, store, logger, identity, establish };
}

describe('establishRegistration', () => {
    it('registers with the link code and takes it from the config', async () => {
        const { dashboard, logger, identity, establish } = await setup();
        const code = dashboard.issueLinkCode('org-a');
        const secret = oneTimeSecret(code);
        const registration = await establish(secret);
        expect(registration?.engineId).toBe(identity.engineId);
        expect(secret.take()).toBeNull();
        expect(logger.entries).toContainEqual({
            level: 'info',
            event: 'registration.registered',
            fields: { engineId: identity.engineId, relays: 1 },
        });
        expect(logger.text()).not.toContain(code);
    });

    it('loads the stored registration without a link code', async () => {
        const { dashboard, logger, establish } = await setup();
        const first = await establish(oneTimeSecret(dashboard.issueLinkCode('org-a')));
        expect(await establish(null)).toEqual(first);
        expect(dashboard.registerRequests).toHaveLength(1);
        expect(logger.entries.at(-1)?.event).toBe('registration.already-registered');
    });

    it('has no registration without a stored one or a link code, so the engine waits for connect', async () => {
        const { dashboard, establish } = await setup();
        expect(await establish(null)).toBeNull();
        expect(dashboard.registerRequests).toHaveLength(0);
    });

    it('fails on a rejection, a refused response and an unreachable dashboard, naming only the outcome', async () => {
        const { clock, dashboard, logger, establish } = await setup();
        const unknown = LinkCode.parse('abcdefghijklmnopqrstuvwxya');
        const rejected = establish(oneTimeSecret(unknown));
        await expect(rejected).rejects.toThrow('registration rejected: invalid-link-code');
        await expect(rejected).rejects.toMatchObject({ exitCode: EXIT_CODE.linkCodeRefused });
        expect(logger.entries.at(-1)).toEqual({
            level: 'error',
            event: 'registration.rejected',
            fields: { reason: 'invalid-link-code' },
        });
        dashboard.overrideRegister(() => ({
            status: 200,
            body: { engineId: 'a'.repeat(26), hostname: `${'a'.repeat(26)}.engines.ptbk.test`, relays: RELAYS },
        }));
        await expect(establish(oneTimeSecret(dashboard.issueLinkCode('org-a')))).rejects.toThrow(
            'registration refused-response: engine-id-mismatch',
        );
        dashboard.unreachable = true;
        const unreachable = settleWithClock(establish(oneTimeSecret(dashboard.issueLinkCode('org-a'))), clock);
        await expect(unreachable).rejects.toThrow('registration unavailable: no-answer');
        await expect(unreachable).rejects.toMatchObject({ exitCode: EXIT_CODE.unreachable });
        expect(logger.text()).not.toContain(unknown);
    });

    it('describes every outcome', () => {
        expect(describeOutcome({ kind: 'unavailable', reason: 'rate-limited' })).toBe('unavailable: rate-limited');
        expect(describeOutcome({ kind: 'rejected', reason: 'engine-limit' })).toBe('rejected: engine-limit');
        expect(describeOutcome({ kind: 'refused-response', reason: 'invalid' })).toBe('refused-response: invalid');
    });
});
