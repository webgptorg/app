import { describe, expect, it } from 'vitest';

import { engineEnvironment } from './launch-env';

describe('engineEnvironment', () => {
    it('drops proxy, CA and PTBK_ variables from the parent and puts the contract last', () => {
        const env = engineEnvironment(
            {
                PATH: '/bin',
                HOME: '/home/x',
                UNSET: undefined,
                PTBK_RELAYS: 'wss://elsewhere',
                https_proxy: 'http://proxy',
                HTTP_PROXY: 'http://proxy',
                ALL_PROXY: 'socks://proxy',
                no_proxy: '*',
                NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
                SSL_CERT_FILE: '/etc/ssl.pem',
                SSL_CERT_DIR: '/etc/ssl',
            },
            { MOCK_SCENARIO: 'empty' },
            { PTBK_DATA_DIR: '/data', NODE_EXTRA_CA_CERTS: '/run/ca.pem' },
        );
        expect(env).toEqual({
            PATH: '/bin',
            HOME: '/home/x',
            MOCK_SCENARIO: 'empty',
            PTBK_DATA_DIR: '/data',
            NODE_EXTRA_CA_CERTS: '/run/ca.pem',
        });
    });

    it('refuses a contract variable among the engine-specific ones', () => {
        expect(() => engineEnvironment({}, { PTBK_RELAYS: 'wss://x' }, {})).toThrow(/launch-contract variable/);
    });
});
