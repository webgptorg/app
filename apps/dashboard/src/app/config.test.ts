import { describe, expect, it } from 'vitest';

import { ConfigError, parseConfig } from './config';

const devVars = {
    ENVIRONMENT: 'dev',
    DASHBOARD_ORIGIN: 'https://app.ptbk.test',
    ENGINE_DOMAIN: 'engines.ptbk.test',
    RELAYS: [{ relayId: 'relay-1.ptbk.test', region: 'eu-central' }],
    ADAPTERS: { email: 'fake', billing: 'fake', rateLimit: 'memory' },
};
const stagingVars = {
    ...devVars,
    ENVIRONMENT: 'staging',
    ADAPTERS: { email: 'cloudflare', billing: 'stripe', rateLimit: 'workers' },
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
        });
        expect(Object.isFrozen(config)).toBe(true);
        expect(Object.isFrozen(config.relays[0])).toBe(true);
        expect(Object.isFrozen(config.adapters)).toBe(true);
    });

    it('accepts real adapters outside dev', () => {
        expect(parseConfig({ ...bindings, ...stagingVars }).environment).toBe('staging');
    });

    it.each(['ENVIRONMENT', 'DASHBOARD_ORIGIN', 'ENGINE_DOMAIN', 'RELAYS', 'ADAPTERS'])(
        'fails closed without %s',
        (name) => {
            const vars = Object.fromEntries(
                Object.entries({ ...bindings, ...devVars }).filter(([key]) => key !== name),
            );
            expect(failedPaths(vars)).toEqual([name]);
        },
    );

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
