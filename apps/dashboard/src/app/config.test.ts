import { describe, expect, it } from 'vitest';

import { syntheticStripeKey, syntheticWebhookSecret, TEST_PLANS } from '../testing/billing-fixtures';
import { ConfigError, DEV_RATE_LIMIT_HMAC_KEY, parseConfig } from './config';

const devVars = {
    ENVIRONMENT: 'dev',
    DASHBOARD_ORIGIN: 'https://app.ptbk.test',
    ENGINE_DOMAIN: 'engines.ptbk.test',
    RELAYS: [{ relayId: 'relay-1.ptbk.test', region: 'eu-central' }],
    INSTALL_COMMAND: 'bun run dev:link {linkCode}',
    ADAPTERS: { email: 'fake', billing: 'fake', rateLimit: 'memory' },
    EMAIL_FROM: 'no-reply@ptbk.test',
    RATE_LIMIT_HMAC_KEY: DEV_RATE_LIMIT_HMAC_KEY,
    BILLING_PLANS: TEST_PLANS,
};
const STAGING_KEY = 'c3RhZ2luZy1zZWNyZXQta2V5LWZvci1yYXRlLWxpbWl0cy0zMmI';
const stagingVars = {
    ...devVars,
    ENVIRONMENT: 'staging',
    ADAPTERS: { email: 'cloudflare', billing: 'stripe', rateLimit: 'workers' },
    RATE_LIMIT_HMAC_KEY: STAGING_KEY,
    STRIPE_SECRET_KEY: syntheticStripeKey(),
    STRIPE_WEBHOOK_SECRET: syntheticWebhookSecret(),
};
class FakeBinding {
    readonly kind = 'binding';
}
const bindings = { DB: new FakeBinding(), ASSETS: new FakeBinding() };

function failedPaths(env: object): readonly string[] {
    try {
        parseConfig(env);
    } catch (error) {
        if (error instanceof ConfigError) {
            return error.paths;
        }
        throw error;
    }
    throw new Error('expected parseConfig to fail');
}

describe('parseConfig', () => {
    it('parses a complete dev configuration into a frozen object', () => {
        const { plans, ...config } = parseConfig({ ...bindings, ...devVars });
        expect(config).toEqual({
            environment: 'dev',
            dashboardOrigin: 'https://app.ptbk.test',
            engineDomain: 'engines.ptbk.test',
            relays: [{ relayId: 'relay-1.ptbk.test', region: 'eu-central' }],
            installCommand: 'bun run dev:link {linkCode}',
            adapters: { email: 'fake', billing: 'fake', rateLimit: 'memory' },
            emailFrom: 'no-reply@ptbk.test',
            rateLimitHmacKey: new TextEncoder().encode('dev-only-rate-limit-key-not-secret'),
            stripeSecretKey: null,
            stripeWebhookSecret: null,
        });
        expect(plans.plans.map((plan) => plan.id)).toEqual(['starter', 'scale']);
        expect(Object.isFrozen(parseConfig({ ...bindings, ...devVars }))).toBe(true);
        expect(Object.isFrozen(config.relays[0])).toBe(true);
        expect(Object.isFrozen(config.adapters)).toBe(true);
    });

    it('accepts real adapters outside dev', () => {
        expect(parseConfig({ ...bindings, ...stagingVars }).environment).toBe('staging');
    });

    it.each([
        'ENVIRONMENT',
        'DASHBOARD_ORIGIN',
        'ENGINE_DOMAIN',
        'RELAYS',
        'INSTALL_COMMAND',
        'ADAPTERS',
        'EMAIL_FROM',
        'RATE_LIMIT_HMAC_KEY',
        'BILLING_PLANS',
    ])('fails closed without %s', (name) => {
        const vars = Object.fromEntries(Object.entries({ ...bindings, ...devVars }).filter(([key]) => key !== name));
        expect(failedPaths(vars)).toEqual([name]);
    });

    it('fails closed on an unknown var', () => {
        expect(failedPaths({ ...bindings, ...devVars, ADMIN_BYPASS: 'true' })).toEqual(['ADMIN_BYPASS']);
        expect(failedPaths({ ...bindings, ...devVars, EXTRA: { nested: true } })).toEqual(['EXTRA']);
    });

    it('leaves runtime bindings to the composition root', () => {
        expect(parseConfig({ ...devVars, DB: new FakeBinding(), SELF: () => undefined }).environment).toBe('dev');
    });

    it('fails closed on an unknown value', () => {
        expect(failedPaths({ ...bindings, ...devVars, ENVIRONMENT: 'qa' })).toEqual(['ENVIRONMENT']);
        expect(failedPaths({ ...bindings, ...devVars, ADAPTERS: { ...devVars.ADAPTERS, sms: 'fake' } })).toEqual([
            'ADAPTERS.sms',
        ]);
    });

    it('refuses the fake billing adapter in staging', () => {
        expect(
            failedPaths({ ...bindings, ...stagingVars, ADAPTERS: { ...stagingVars.ADAPTERS, billing: 'fake' } }),
        ).toEqual(['ADAPTERS.billing']);
    });

    it.each([
        ['email', 'fake'],
        ['rateLimit', 'memory'],
    ])('refuses %s=%s in production', (port, adapter) => {
        const env = {
            ...bindings,
            ...stagingVars,
            ENVIRONMENT: 'production',
            ADAPTERS: { ...stagingVars.ADAPTERS, [port]: adapter },
        };
        expect(failedPaths(env)).toEqual([`ADAPTERS.${port}`]);
    });

    it('requires both Stripe secrets with the stripe billing adapter, and neither with the fake', () => {
        const withoutSecrets = Object.fromEntries(
            Object.entries(stagingVars).filter(([name]) => !name.startsWith('STRIPE_')),
        );
        expect(failedPaths({ ...bindings, ...withoutSecrets })).toEqual(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);
        const secret = syntheticWebhookSecret();
        const config = parseConfig({ ...bindings, ...stagingVars, STRIPE_WEBHOOK_SECRET: secret });
        expect(config.stripeWebhookSecret).toBe(secret);
        expect(parseConfig({ ...bindings, ...devVars, STRIPE_WEBHOOK_SECRET: secret }).stripeWebhookSecret).toBe(
            secret,
        );
    });

    it('allows live Stripe keys only in production', () => {
        const live = syntheticStripeKey('live');
        expect(failedPaths({ ...bindings, ...stagingVars, STRIPE_SECRET_KEY: live })).toEqual(['STRIPE_SECRET_KEY']);
        expect(failedPaths({ ...bindings, ...devVars, STRIPE_SECRET_KEY: live })).toEqual(['STRIPE_SECRET_KEY']);
        const production = { ...bindings, ...stagingVars, ENVIRONMENT: 'production', STRIPE_SECRET_KEY: live };
        expect(parseConfig(production).stripeSecretKey).toBe(live);
        expect(failedPaths({ ...bindings, ...stagingVars, STRIPE_SECRET_KEY: 'pk_test_publishable' })).toEqual([
            'STRIPE_SECRET_KEY',
        ]);
    });

    it('rejects an invalid plan catalogue at parse', () => {
        const [starter] = TEST_PLANS.plans;
        expect(
            failedPaths({
                ...bindings,
                ...devVars,
                BILLING_PLANS: { ...TEST_PLANS, plans: [starter, { ...starter, stripePriceId: 'price_other' }] },
            }),
        ).toEqual(['BILLING_PLANS.plans.1.id']);
        expect(failedPaths({ ...bindings, ...devVars, BILLING_PLANS: { plans: TEST_PLANS.plans } })).toEqual([
            'BILLING_PLANS.none',
        ]);
    });

    it('requires an https origin outside dev and a bare origin everywhere', () => {
        expect(failedPaths({ ...bindings, ...stagingVars, DASHBOARD_ORIGIN: 'http://app.ptbk.test' })).toEqual([
            'DASHBOARD_ORIGIN',
        ]);
        expect(failedPaths({ ...bindings, ...devVars, DASHBOARD_ORIGIN: 'https://app.ptbk.test/x' })).toEqual([
            'DASHBOARD_ORIGIN',
        ]);
    });

    it('refuses the committed dev HMAC key outside dev, and a key shorter than 256 bits anywhere', () => {
        expect(failedPaths({ ...bindings, ...stagingVars, RATE_LIMIT_HMAC_KEY: DEV_RATE_LIMIT_HMAC_KEY })).toEqual([
            'RATE_LIMIT_HMAC_KEY',
        ]);
        expect(failedPaths({ ...bindings, ...devVars, RATE_LIMIT_HMAC_KEY: 'c2hvcnQ' })).toEqual([
            'RATE_LIMIT_HMAC_KEY',
        ]);
        expect(parseConfig({ ...bindings, ...stagingVars }).rateLimitHmacKey).toHaveLength(38);
    });

    it('requires a plain sender address', () => {
        expect(failedPaths({ ...bindings, ...devVars, EMAIL_FROM: 'Promptbook' })).toEqual(['EMAIL_FROM']);
    });

    it('validates relays as hostnames with a region label', () => {
        expect(failedPaths({ ...bindings, ...devVars, RELAYS: [] })).toEqual(['RELAYS']);
        expect(failedPaths({ ...bindings, ...devVars, RELAYS: [{ relayId: '10.0.0.1', region: 'eu' }] })).toEqual([
            'RELAYS.0.relayId',
        ]);
        expect(failedPaths({ ...bindings, ...devVars, RELAYS: [{ relayId: 'relay', region: 'eu' }] })).toEqual([
            'RELAYS.0.relayId',
        ]);
        expect(
            failedPaths({ ...bindings, ...devVars, RELAYS: [{ relayId: 'r.ptbk.test', region: 'EU Central' }] }),
        ).toEqual(['RELAYS.0.region']);
        const relay = { relayId: 'r.ptbk.test', region: 'eu' };
        expect(failedPaths({ ...bindings, ...devVars, RELAYS: [relay, { ...relay, relayId: 'R.ptbk.test' }] })).toEqual(
            ['RELAYS'],
        );
    });

    it('needs the link code placeholder exactly once in the install command', () => {
        for (const command of ['bun run dev:link', 'link {linkCode} {linkCode}', '']) {
            expect(failedPaths({ ...bindings, ...devVars, INSTALL_COMMAND: command })).toEqual(['INSTALL_COMMAND']);
        }
    });

    it('never puts a value into the error', () => {
        const error = (() => {
            try {
                parseConfig({ ...bindings, ...devVars, ENGINE_DOMAIN: 'secret-value_!' });
            } catch (caught) {
                return caught;
            }
            return undefined;
        })();
        expect(error).toBeInstanceOf(ConfigError);
        expect(String(error)).not.toContain('secret-value');
    });
});
