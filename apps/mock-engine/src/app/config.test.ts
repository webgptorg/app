import { inspect } from 'node:util';

import { MAX_RELAYS } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import packageJson from '../../package.json';
import { ConfigError, parseIdentityConfig, parseMockEngineConfig } from './config';

const BASE = {
    PTBK_DATA_DIR: '/var/lib/ptbk',
    PTBK_ENGINE_DOMAIN: 'engines.example.test',
    PTBK_RELAYS: 'wss://relay-a.example.test',
} as const;

function problemsOf(env: Record<string, string | undefined>): readonly string[] {
    try {
        parseMockEngineConfig(env);
    } catch (error) {
        if (error instanceof ConfigError) return error.problems;
        throw error;
    }
    throw new Error('expected a ConfigError');
}

function errorOf(env: Record<string, string | undefined>): ConfigError {
    try {
        parseMockEngineConfig(env);
    } catch (error) {
        if (error instanceof ConfigError) return error;
        throw error;
    }
    throw new Error('expected a ConfigError');
}

describe('parseMockEngineConfig', () => {
    it('parses the minimal environment with defaults', () => {
        const config = parseMockEngineConfig(BASE);
        expect(config).toEqual({
            mode: 'tunnel',
            dataDir: '/var/lib/ptbk',
            relays: [{ url: 'wss://relay-a.example.test/v1/tunnel', relayId: 'relay-a.example.test', port: 443 }],
            engineDomain: 'engines.example.test',
            engineVersion: packageJson.version,
            proxy: null,
            extraCaFile: null,
            devCaFiles: null,
            devCaDomains: [],
            logLevel: 'info',
        });
        expect(Object.isFrozen(config)).toBe(true);
        expect(Object.isFrozen(config.relays)).toBe(true);
        expect(Object.isFrozen(config.relays[0])).toBe(true);
    });

    it('parses every setting', () => {
        const config = parseMockEngineConfig({
            ...BASE,
            PTBK_MODE: 'tunnel',
            PTBK_RELAYS: ' wss://Relay-A.example.test:8443/v1/tunnel , wss://relay-b.example.test:443/ ',
            PTBK_ENGINE_VERSION: '1.8.2-beta.1',
            MOCK_EXTRA_CA_FILE: '/etc/ptbk/dev-ca.pem',
            LOG_LEVEL: 'warn',
            PATH: '/usr/bin',
        });
        expect(config.relays).toEqual([
            { url: 'wss://relay-a.example.test:8443/v1/tunnel', relayId: 'relay-a.example.test', port: 8443 },
            { url: 'wss://relay-b.example.test/v1/tunnel', relayId: 'relay-b.example.test', port: 443 },
        ]);
        expect(config.engineVersion).toBe('1.8.2-beta.1');
        expect(config.extraCaFile).toBe('/etc/ptbk/dev-ca.pem');
        expect(config.logLevel).toBe('warn');
    });

    describe('dev CA', () => {
        it('takes the CA files together and the extra permitted domains', () => {
            const config = parseMockEngineConfig({
                ...BASE,
                MOCK_DEV_CA_CERT_FILE: '/run/ptbk/ca-cert.pem',
                MOCK_DEV_CA_KEY_FILE: '/run/ptbk/ca-key.pem',
                MOCK_DEV_CA_DOMAINS: ' engine.test , PTBK.test,',
            });
            expect(config.devCaFiles).toEqual({ certFile: '/run/ptbk/ca-cert.pem', keyFile: '/run/ptbk/ca-key.pem' });
            expect(config.devCaDomains).toEqual(['engine.test', 'ptbk.test']);
            expect(Object.isFrozen(config.devCaDomains)).toBe(true);
        });

        it('refuses one CA file without the other', () => {
            expect(problemsOf({ ...BASE, MOCK_DEV_CA_KEY_FILE: '/run/ptbk/ca-key.pem' })).toEqual([
                'MOCK_DEV_CA_CERT_FILE: must be set together with MOCK_DEV_CA_KEY_FILE',
            ]);
            expect(problemsOf({ ...BASE, MOCK_DEV_CA_CERT_FILE: '/run/ptbk/ca-cert.pem' })).toEqual([
                'MOCK_DEV_CA_CERT_FILE: must be set together with MOCK_DEV_CA_KEY_FILE',
            ]);
        });

        it('refuses domains that are not hostnames, and too many of them', () => {
            expect(problemsOf({ ...BASE, MOCK_DEV_CA_DOMAINS: 'engine.test,127.0.0.1,*.ptbk.test' })).toEqual([
                'MOCK_DEV_CA_DOMAINS: entry 2 must be a hostname',
                'MOCK_DEV_CA_DOMAINS: entry 3 must be a hostname',
            ]);
            const many = Array.from({ length: 17 }, (_, index) => `d${String(index)}.test`).join(',');
            expect(problemsOf({ ...BASE, MOCK_DEV_CA_DOMAINS: many })).toEqual([
                'MOCK_DEV_CA_DOMAINS: must list at most 16 domains',
            ]);
        });
    });

    it('treats empty values as unset', () => {
        expect(parseMockEngineConfig({ ...BASE, PTBK_MODE: '', LOG_LEVEL: '', HTTPS_PROXY: '' }).proxy).toBeNull();
        expect(problemsOf({ ...BASE, PTBK_DATA_DIR: '' })).toEqual(['PTBK_DATA_DIR: is required']);
    });

    it('requires the data directory, engine domain and relays', () => {
        expect(problemsOf({})).toEqual([
            'PTBK_DATA_DIR: is required',
            'PTBK_RELAYS: is required',
            'PTBK_ENGINE_DOMAIN: is required',
        ]);
    });

    it('accepts only tunnel mode', () => {
        expect(problemsOf({ ...BASE, PTBK_MODE: 'direct' })).toEqual([
            'PTBK_MODE: only tunnel is supported by the mock engine',
        ]);
    });

    it('rejects unknown PTBK_ and MOCK_ settings', () => {
        expect(problemsOf({ ...BASE, PTBK_UPDATE_POLICY: 'auto', MOCK_SEED: '1' })).toEqual([
            'PTBK_UPDATE_POLICY: is not a mock engine setting',
            'MOCK_SEED: is not a mock engine setting',
        ]);
    });

    it.each([
        ['PTBK_ENGINE_DOMAIN', '127.0.0.1', 'must be a hostname'],
        ['PTBK_ENGINE_VERSION', '1.8', 'must be a SemVer version'],
        ['PTBK_DATA_DIR', 'a\0b', 'must be a file path'],
        ['MOCK_EXTRA_CA_FILE', 'x'.repeat(4097), 'must be a file path'],
        ['LOG_LEVEL', 'debug', 'must be one of info, warn, error'],
    ])('rejects an invalid %s', (name, setting, problem) => {
        expect(problemsOf({ ...BASE, [name]: setting })).toEqual([`${name}: ${problem}`]);
    });

    describe('PTBK_RELAYS', () => {
        it.each([
            ['https://relay-a.example.test', 'must be a wss:// URL without query or fragment'],
            ['ws://relay-a.example.test', 'must be a wss:// URL without query or fragment'],
            ['not a url', 'must be a wss:// URL without query or fragment'],
            ['wss://relay-a.example.test/v1/tunnel?x=1', 'must be a wss:// URL without query or fragment'],
            ['wss://relay-a.example.test/?', 'must be a wss:// URL without query or fragment'],
            ['wss://relay-a.example.test/#', 'must be a wss:// URL without query or fragment'],
            [`wss://relay-a.example.test/${'a'.repeat(2048)}`, 'must be a wss:// URL without query or fragment'],
            ['wss://user:pw@relay-a.example.test', 'must not contain credentials'],
            ['wss://user@relay-a.example.test', 'must not contain credentials'],
            ['wss://relay-a.example.test/other', 'must have no path or /v1/tunnel'],
            ['wss://127.0.0.1', 'must name the relay by hostname, not an IP address'],
            ['wss://[::1]:8443', 'must name the relay by hostname, not an IP address'],
            ['wss://localhost', 'must name the relay by hostname, not an IP address'],
        ])('rejects %s', (entry, problem) => {
            expect(problemsOf({ ...BASE, PTBK_RELAYS: entry })).toEqual([`PTBK_RELAYS: entry 1 ${problem}`]);
        });

        it('rejects an empty entry and reports its position', () => {
            expect(problemsOf({ ...BASE, PTBK_RELAYS: 'wss://relay-a.example.test,,' })).toEqual([
                'PTBK_RELAYS: entry 2 must be a wss:// URL without query or fragment',
                'PTBK_RELAYS: entry 3 must be a wss:// URL without query or fragment',
            ]);
        });

        it('rejects a relay listed twice, also in another spelling', () => {
            expect(
                problemsOf({
                    ...BASE,
                    PTBK_RELAYS: 'wss://relay-a.example.test,wss://RELAY-A.example.test:443/v1/tunnel',
                }),
            ).toEqual(['PTBK_RELAYS: entry 2 repeats a relay']);
        });

        it(`accepts ${String(MAX_RELAYS)} relays and refuses more`, () => {
            const relays = (count: number): string =>
                Array.from({ length: count }, (_, index) => `wss://relay-${String(index)}.example.test`).join(',');
            expect(parseMockEngineConfig({ ...BASE, PTBK_RELAYS: relays(MAX_RELAYS) }).relays).toHaveLength(MAX_RELAYS);
            expect(problemsOf({ ...BASE, PTBK_RELAYS: relays(MAX_RELAYS + 1) })).toEqual([
                `PTBK_RELAYS: must list at most ${String(MAX_RELAYS)} relays`,
            ]);
        });
    });

    describe('proxy', () => {
        it('parses an http proxy with credentials and NO_PROXY rules', () => {
            const config = parseMockEngineConfig({
                ...BASE,
                HTTPS_PROXY: 'http://us%40er:p%3Ass@proxy.corp.test:3128',
                NO_PROXY: ' .Internal.test , relay-b.example.test:8443,*, [::1]:443,[fe80::1],::1, 10.0.0.0/8,, ',
            });
            const proxy = config.proxy;
            expect(proxy).not.toBeNull();
            expect(proxy?.host).toBe('proxy.corp.test');
            expect(proxy?.port).toBe(3128);
            expect(proxy?.credentials?.username).toBe('us@er');
            expect(proxy?.credentials?.password.reveal()).toBe('p:ss');
            expect(proxy?.noProxy).toEqual([
                { host: 'internal.test', port: null },
                { host: 'relay-b.example.test', port: 8443 },
                { host: '*', port: null },
                { host: '::1', port: 443 },
                { host: 'fe80::1', port: null },
                { host: '::1', port: null },
                { host: '10.0.0.0/8', port: null },
            ]);
            expect(Object.isFrozen(proxy)).toBe(true);
            expect(Object.isFrozen(proxy?.noProxy)).toBe(true);
            expect(Object.isFrozen(proxy?.credentials)).toBe(true);
        });

        it('defaults to port 80, no credentials and no NO_PROXY rules', () => {
            expect(parseMockEngineConfig({ ...BASE, https_proxy: 'http://proxy.corp.test/' }).proxy).toEqual({
                host: 'proxy.corp.test',
                port: 80,
                credentials: null,
                noProxy: [],
            });
        });

        it('takes an IPv6 proxy without brackets and a user without a password', () => {
            const proxy = parseMockEngineConfig({ ...BASE, HTTPS_PROXY: 'http://user@[fd00::1]:8080' }).proxy;
            expect(proxy?.host).toBe('fd00::1');
            expect(proxy?.credentials?.username).toBe('user');
            expect(proxy?.credentials?.password.reveal()).toBe('');
        });

        it('ignores NO_PROXY without a proxy', () => {
            expect(parseMockEngineConfig({ ...BASE, no_proxy: '*' }).proxy).toBeNull();
        });

        it('accepts the same value in both spellings', () => {
            const config = parseMockEngineConfig({
                ...BASE,
                HTTPS_PROXY: 'http://proxy.corp.test:3128',
                https_proxy: 'http://proxy.corp.test:3128',
                NO_PROXY: 'a.test',
                no_proxy: 'a.test',
            });
            expect(config.proxy?.noProxy).toEqual([{ host: 'a.test', port: null }]);
        });

        it('rejects differing upper- and lowercase variables', () => {
            expect(
                problemsOf({
                    ...BASE,
                    HTTPS_PROXY: 'http://a.test:1',
                    https_proxy: 'http://b.test:1',
                    NO_PROXY: 'a.test',
                    no_proxy: 'b.test',
                }),
            ).toEqual([
                'HTTPS_PROXY: differs from https_proxy; set only one',
                'NO_PROXY: differs from no_proxy; set only one',
            ]);
        });

        it.each([
            ['https://proxy.corp.test:3128', 'https:// proxies are not supported; use an http:// proxy URL'],
            ['socks5://proxy.corp.test:1080', 'must be an http://[user:password@]host[:port] URL'],
            ['proxy.corp.test:3128', 'must be an http://[user:password@]host[:port] URL'],
            ['http://proxy.corp.test:3128/path', 'must be an http://[user:password@]host[:port] URL'],
            ['http://proxy.corp.test:3128/?a', 'must be an http://[user:password@]host[:port] URL'],
            ['http://u:%E0%A4%A@proxy.corp.test:3128', 'has invalid percent-encoding in its credentials'],
            ['http://%E0%A4%A:p@proxy.corp.test:3128', 'has invalid percent-encoding in its credentials'],
        ])('rejects the proxy %s', (proxy, problem) => {
            expect(problemsOf({ ...BASE, HTTPS_PROXY: proxy })).toEqual([`HTTPS_PROXY: ${problem}`]);
        });

        it.each([
            'host:0',
            'host:70000',
            'ho st',
            '[::1]:0',
            '[::1',
            '[::1]x',
            '[zz]',
            'fe80::zz',
            '*.example.test',
            'host:port',
        ])('rejects the NO_PROXY entry %s', (entry) => {
            expect(problemsOf({ ...BASE, HTTPS_PROXY: 'http://p.test:1', NO_PROXY: `a.test,${entry}` })).toEqual([
                'NO_PROXY: entry 2 must be *, a host or domain, or an IP address',
            ]);
        });

        it('bounds the NO_PROXY list', () => {
            const list = Array.from({ length: 257 }, (_, index) => `h${String(index)}.test`).join(',');
            expect(problemsOf({ ...BASE, HTTPS_PROXY: 'http://p.test:1', NO_PROXY: list })).toEqual([
                'NO_PROXY: must list at most 256 entries',
            ]);
        });

        it('never puts the proxy URL or password in an error', () => {
            const password = 'hunter2-secret';
            const error = errorOf({
                ...BASE,
                PTBK_MODE: 'local',
                HTTPS_PROXY: `https://admin:${password}@proxy.corp.test:3128`,
                https_proxy: `http://admin:${password}@proxy.corp.test:3129`,
            });
            const text = `${error.message} ${JSON.stringify(error.problems)}`;
            expect(text).not.toContain(password);
            expect(text).not.toContain('proxy.corp.test');
        });

        it('never reveals the password when the config is serialised', () => {
            const config = parseMockEngineConfig({ ...BASE, HTTPS_PROXY: 'http://admin:hunter2@proxy.corp.test:3128' });
            expect(JSON.stringify(config)).not.toContain('hunter2');
            expect(inspect(config, { depth: null })).not.toContain('hunter2');
        });
    });
});

describe('parseIdentityConfig', () => {
    it('reads only the data directory and engine domain', () => {
        expect(
            parseIdentityConfig({
                ...BASE,
                PTBK_RELAYS: 'not a url',
                PTBK_MODE: 'local',
                PTBK_UNKNOWN: 'x',
            }),
        ).toEqual({ dataDir: '/var/lib/ptbk', engineDomain: 'engines.example.test' });
    });

    it('requires both and treats empty values as unset', () => {
        expect(() => parseIdentityConfig({ PTBK_DATA_DIR: '', PTBK_ENGINE_DOMAIN: 'x' })).toThrow(
            'Invalid mock engine configuration: PTBK_DATA_DIR: is required; PTBK_ENGINE_DOMAIN: must be a hostname',
        );
    });
});
