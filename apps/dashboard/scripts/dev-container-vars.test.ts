import { describe, expect, it } from 'vitest';

import { mergeWorkerVars } from './dev-container-vars.ts';

const built = JSON.stringify({
    name: 'ptbk-dashboard',
    vars: { ENVIRONMENT: 'dev', ENGINE_DOMAIN: 'engines.ptbk.test', RELAYS: [{ relayId: 'relay.ptbk.test' }] },
});

describe('mergeWorkerVars', () => {
    it('replaces the named vars, JSON values included, and keeps the rest of the config', () => {
        const merged: unknown = JSON.parse(
            mergeWorkerVars(
                built,
                JSON.stringify({
                    ENGINE_DOMAIN: 'engine.test',
                    RELAYS: [{ relayId: 'relay-a.ptbk.test' }],
                    LINK_CODE_TTL_S: 30,
                }),
            ),
        );
        expect(merged).toEqual({
            name: 'ptbk-dashboard',
            vars: {
                ENVIRONMENT: 'dev',
                ENGINE_DOMAIN: 'engine.test',
                RELAYS: [{ relayId: 'relay-a.ptbk.test' }],
                LINK_CODE_TTL_S: 30,
            },
        });
    });

    it('adds vars to a config without any', () => {
        expect(JSON.parse(mergeWorkerVars('{}', '{"ENGINE_DOMAIN":"engine.test"}'))).toEqual({
            vars: { ENGINE_DOMAIN: 'engine.test' },
        });
    });

    it.each([
        ['not JSON', 'ENGINE_DOMAIN=engine.test', /not JSON/],
        ['an array', '[]', /JSON object/],
        ['a lowercase name', '{"engine_domain":"engine.test"}', /not a var name: engine_domain/],
    ])('refuses DASHBOARD_VARS that is %s', (_, vars, message) => {
        expect(() => mergeWorkerVars(built, vars)).toThrow(message);
    });

    it('refuses a built config that is not an object', () => {
        expect(() => mergeWorkerVars('[]', '{}')).toThrow(/not a JSON object/);
    });
});
