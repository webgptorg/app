import { describe, expect, it } from 'vitest';

import { syntheticStripeKey, syntheticWebhookSecret, TEST_PLANS } from '../testing/billing-fixtures';
import { TEST_INSTALL_VARS } from '../testing/install-fixtures';
import { createMemoryEngineStatusStorage } from '../testing/memory-engine-status';
import { ConfigError, DEV_RATE_LIMIT_HMAC_KEY } from './config';
import { createDevAdapters } from './dev-adapters';
import { createEngineStatus } from './engine-status';

const vars = {
    ENVIRONMENT: 'dev',
    DASHBOARD_ORIGIN: 'http://localhost:5173',
    ENGINE_DOMAIN: 'engines.ptbk.test',
    RELAYS: [{ relayId: 'relay.ptbk.test', region: 'local' }],
    ...TEST_INSTALL_VARS,
    ADAPTERS: { email: 'fake', billing: 'fake', rateLimit: 'memory' },
    EMAIL_FROM: 'no-reply@ptbk.test',
    ABUSE_EMAIL: 'abuse@ptbk.test',
    RATE_LIMIT_HMAC_KEY: DEV_RATE_LIMIT_HMAC_KEY,
    BILLING_PLANS: TEST_PLANS,
};

class FakeBinding {
    readonly kind = 'binding';
}

function env(overrides: Record<string, unknown> = {}): Env {
    return { ...vars, DB: new FakeBinding(), ...overrides } as unknown as Env;
}

describe('createEngineStatus', () => {
    it('builds an engine’s status service from the Worker’s bindings', async () => {
        const service = createEngineStatus(env(), createMemoryEngineStatusStorage(), createDevAdapters());
        expect(await service.getStatus()).toEqual({ state: 'never-seen' });
    });

    it('counts every alarm it handles (I-04)', async () => {
        const dev = createDevAdapters();
        const service = createEngineStatus(env(), createMemoryEngineStatusStorage(), dev);
        await service.alarm();
        await service.reset();
        expect(dev.metrics.records.map((record) => record.metric)).toEqual([
            { name: 'ptbk_dashboard_alarms_total', object: 'engine-status' },
        ]);
    });

    it('refuses a configuration the Worker would refuse, and a missing email binding', () => {
        const storage = createMemoryEngineStatusStorage();
        expect(() => createEngineStatus(env({ ENVIRONMENT: 'qa' }), storage, createDevAdapters())).toThrow(ConfigError);
        const noEmail = env({
            ENVIRONMENT: 'staging',
            DASHBOARD_ORIGIN: 'https://app.staging.ptbk.test',
            ADAPTERS: { email: 'cloudflare', billing: 'stripe', rateLimit: 'workers' },
            RATE_LIMIT_HMAC_KEY: 'c3RhZ2luZy1zZWNyZXQta2V5LWZvci1yYXRlLWxpbWl0cy0zMmI',
            STRIPE_SECRET_KEY: syntheticStripeKey(),
            STRIPE_WEBHOOK_SECRET: syntheticWebhookSecret(),
        });
        expect(() => createEngineStatus(noEmail, storage, createDevAdapters())).toThrow(/email binding/);
    });
});
