import { describe, expect, it } from 'vitest';

import { ConfigError, DEV_RATE_LIMIT_HMAC_KEY, parseConfig } from './config';

const devVars = {
    ENVIRONMENT: 'dev',
    DASHBOARD_ORIGIN: 'https://app.ptbk.test',
    ENGINE_DOMAIN: 'engines.ptbk.test',
    RELAYS: [{ relayId: 'relay-1.ptbk.test', region: 'eu-central' }],
    ADAPTERS: { email: 'fake', billing: 'fake', rateLimit: 'memory' },
    EMAIL_FROM: 'no-reply@ptbk.test',
    RATE_LIMIT_HMAC_KEY: DEV_RATE_LIMIT_HMAC_KEY,
};
const STAGING_KEY = 'c3RhZ2luZy1zZWNyZXQta2V5LWZvci1yYXRlLWxpbWl0cy0zMmI';
const stagingVars = {
    ...devVars,
    ENVIRONMENT: 'staging',
    ADAPTERS: { email: 'cloudflare', billing: 'stripe', rateLimit: 'workers' },
    RATE_LIMIT_HMAC_KEY: STAGING_KEY,
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
        const config = parseConfig({ ...bindings, ...devVars });
        expect(config).toEqual({
            environment: 'dev',
            dashboardOrigin: 'https://app.ptbk.test',
            engineDomain: 'engines.ptbk.test',
            relays: [{ relayId: 'relay-1.ptbk.test', region: 'eu-central' }],
            adapters: { email: 'fake', billing: 'fake', rateLimit: 'memory' },
            emailFrom: 'no-reply@ptbk.test',
            rateLimitHmacKey: new TextEncoder().encode('dev-only-rate-limit-key-not-secret'),
        });
        expect(Object.isFrozen(config)).toBe(true);
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
        'ADAPTERS',
        'EMAIL_FROM',
        'RATE_LIMIT_HMAC_KEY',
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
