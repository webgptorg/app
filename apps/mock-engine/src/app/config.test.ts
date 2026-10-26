import { inspect } from 'node:util';

import { MAX_RELAYS } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import packageJson from '../../package.json';
import { DEFAULT_MOCK_SETTINGS } from '../testing/mock-settings';
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
            certificateSource: { kind: 'dev-ca' },
            logLevel: 'info',
            ...DEFAULT_MOCK_SETTINGS,
            // Tests keep the simulation paused; a real engine runs it unless told otherwise.
            simulation: { mode: 'running', speed: 1 },
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

    describe('certificate source', () => {
        const ACME = { ...BASE, MOCK_CERT_SOURCE: 'acme', PTBK_ACME_DIRECTORY_URL: 'https://pebble:14000/dir' };

        it('takes certificates from the dev CA by default', () => {
            expect(parseMockEngineConfig(BASE).certificateSource).toEqual({ kind: 'dev-ca' });
        });

        it('takes them from an ACME directory with MOCK_CERT_SOURCE=acme, with an optional contact', () => {
            expect(parseMockEngineConfig(ACME).certificateSource).toEqual({
                kind: 'acme',
                directoryUrl: 'https://pebble:14000/dir',
                email: null,
            });
            const withEmail = parseMockEngineConfig({
                ...ACME,
                PTBK_ACME_DIRECTORY_URL: 'https://acme-staging-v02.api.letsencrypt.org/directory',
                PTBK_ACME_EMAIL: 'ops@example.test',
            }).certificateSource;
            expect(withEmail).toEqual({
                kind: 'acme',
                directoryUrl: 'https://acme-staging-v02.api.letsencrypt.org/directory',
                email: 'ops@example.test',
            });
            expect(Object.isFrozen(withEmail)).toBe(true);
        });

        it("requires the directory with acme, and refuses each source the other one's settings", () => {
            expect(problemsOf({ ...BASE, MOCK_CERT_SOURCE: 'acme' })).toEqual([
                'PTBK_ACME_DIRECTORY_URL: is required with MOCK_CERT_SOURCE=acme',
            ]);
            expect(problemsOf({ ...ACME, MOCK_DEV_CA_DOMAINS: 'ptbk.test' })).toEqual([
                'MOCK_DEV_CA_DOMAINS: needs MOCK_CERT_SOURCE=dev-ca',
            ]);
            expect(problemsOf({ ...BASE, PTBK_ACME_DIRECTORY_URL: 'https://pebble:14000/dir' })).toEqual([
                'PTBK_ACME_DIRECTORY_URL: needs MOCK_CERT_SOURCE=acme',
            ]);
            expect(problemsOf({ ...BASE, PTBK_ACME_EMAIL: 'ops@example.test' })).toEqual([
                'PTBK_ACME_EMAIL: needs MOCK_CERT_SOURCE=acme',
            ]);
        });

        it('refuses another source, a directory that is not plain https, and an address that is not one', () => {
            expect(problemsOf({ ...BASE, MOCK_CERT_SOURCE: 'files' })).toEqual([
                'MOCK_CERT_SOURCE: must be dev-ca or acme',
            ]);
            for (const url of [
                'http://pebble:14000/dir',
                'https://user:pw@pebble/dir',
                'https://pebble/dir#x',
                'pebble',
            ]) {
                expect(problemsOf({ ...ACME, PTBK_ACME_DIRECTORY_URL: url })).toEqual([
                    'PTBK_ACME_DIRECTORY_URL: must be an https:// URL without credentials or fragment',
                ]);
            }
            expect(problemsOf({ ...ACME, PTBK_ACME_DIRECTORY_URL: `https://pebble/${'a'.repeat(2048)}` })).toHaveLength(
                1,
            );
            expect(problemsOf({ ...ACME, PTBK_ACME_EMAIL: 'not an address' })).toEqual([
                'PTBK_ACME_EMAIL: must be an email address',
            ]);
        });
    });

    it('treats empty values as unset', () => {
        expect(parseMockEngineConfig({ ...BASE, PTBK_MODE: '', LOG_LEVEL: '', HTTPS_PROXY: '' }).proxy).toBeNull();
        expect(problemsOf({ ...BASE, PTBK_DATA_DIR: '' })).toEqual(['PTBK_DATA_DIR: is required']);
    });

    it('requires the data directory, engine domain and, without a dashboard, relays', () => {
        expect(problemsOf({})).toEqual([
            'PTBK_DATA_DIR: is required',
            'PTBK_ENGINE_DOMAIN: is required',
            'PTBK_RELAYS: is required without PTBK_DASHBOARD_URL',
        ]);
    });

    describe('M-06 settings', () => {
        const CODE = 'abcdefghijklmnopqrstuvwxya';
        const LINKED = { ...BASE, PTBK_RELAYS: undefined, PTBK_DASHBOARD_URL: 'https://App.ptbk.test/' };

        it('reads the dashboard origin, with relays optional and heartbeats every 60 s by default', () => {
            const config = parseMockEngineConfig(LINKED);
            expect(config.relays).toEqual([]);
            expect(config.stats).toBe('os');
            expect(config.dashboard).toEqual({
                url: 'https://app.ptbk.test',
                linkCode: null,
                heartbeatIntervalS: 60,
            });
            expect(parseMockEngineConfig(BASE).dashboard).toBeNull();
        });

        it('takes the link code once and never shows it', () => {
            const config = parseMockEngineConfig({ ...LINKED, PTBK_LINK_CODE: CODE });
            expect(JSON.stringify(config)).not.toContain(CODE);
            expect(inspect(config, { depth: 5 })).not.toContain(CODE);
            expect(config.dashboard?.linkCode?.take()).toBe(CODE);
            expect(config.dashboard?.linkCode?.take()).toBeNull();
        });

        it('reads the interval, the relay override and the stats source', () => {
            const config = parseMockEngineConfig({
                ...LINKED,
                PTBK_RELAYS: 'wss://relay-a.example.test',
                MOCK_HEARTBEAT_INTERVAL_S: '15',
                MOCK_STATS: 'scenario',
            });
            expect(config.dashboard).toMatchObject({ heartbeatIntervalS: 15 });
            expect(config.relays).toHaveLength(1);
            expect(config.stats).toBe('scenario');
        });

        it('refuses bad values without quoting them', () => {
            const problems = problemsOf({
                ...LINKED,
                PTBK_DASHBOARD_URL: 'http://user:pw@app.ptbk.test/path',
                PTBK_LINK_CODE: 'NOT-A-CODE-secretish',
                MOCK_HEARTBEAT_INTERVAL_S: '0',
                MOCK_STATS: 'host',
            });
            expect(problems).toEqual(
                expect.arrayContaining([
                    'PTBK_DASHBOARD_URL: must be an https:// origin without credentials or path',
                    'PTBK_LINK_CODE: must be a link code',
                    'MOCK_HEARTBEAT_INTERVAL_S: must be a whole number of seconds from 1 to 3600',
                    'MOCK_STATS: must be os or scenario',
                ]),
            );
            expect(problems.join(' ')).not.toContain('secretish');
            expect(problemsOf({ ...LINKED, MOCK_HEARTBEAT_INTERVAL_S: '3601' })).toHaveLength(1);
            expect(problemsOf({ ...LINKED, PTBK_DASHBOARD_URL: 'https://app.ptbk.test/?x' })).toHaveLength(1);
        });

        it('needs a dashboard for a link code', () => {
            expect(problemsOf({ ...BASE, PTBK_LINK_CODE: CODE })).toEqual(['PTBK_LINK_CODE: needs PTBK_DASHBOARD_URL']);
        });
    });

    it('accepts only tunnel mode', () => {
        expect(problemsOf({ ...BASE, PTBK_MODE: 'direct' })).toEqual([
            'PTBK_MODE: only tunnel is supported by the mock engine',
        ]);
    });

    it('rejects unknown PTBK_ and MOCK_ settings', () => {
        expect(problemsOf({ ...BASE, PTBK_AUTO_UPDATE: 'auto', MOCK_SEEDS: '1' })).toEqual([
            'PTBK_AUTO_UPDATE: is not a mock engine setting',
            'MOCK_SEEDS: is not a mock engine setting',
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

    describe('M-04 settings', () => {
        it('reads the seed, scenario, epoch, faults, dev login and control listener', () => {
            const config = parseMockEngineConfig({
                ...BASE,
                MOCK_SEED: '42',
                MOCK_SCENARIO: 'large-fleet',
                MOCK_SEED_EPOCH: '2026-09-01T12:00:00Z',
                MOCK_FAULTS: '{"errorRate":0.5,"errorStatus":502,"routes":["/api/v1/agents/**"]}',
                MOCK_DEV_LOGIN: 'enabled',
                MOCK_CONTROL: 'enabled',
                MOCK_CONTROL_HOST: '0.0.0.0',
                MOCK_CONTROL_PORT: '9000',
            });
            expect(config).toMatchObject({
                seed: 42,
                scenario: 'large-fleet',
                seedEpoch: new Date('2026-09-01T12:00:00Z'),
                faults: { errorRate: 0.5, errorStatus: 502, routes: ['/api/v1/agents/**'] },
                devLogin: true,
                control: { host: '0.0.0.0', port: 9000 },
            });
            expect(parseMockEngineConfig({ ...BASE, MOCK_CONTROL: 'enabled' }).control).toEqual({
                host: '127.0.0.1',
                port: 4480,
            });
        });

        it.each([
            ['MOCK_SEED', '-1'],
            ['MOCK_SEED', '4294967296'],
            ['MOCK_SCENARIO', 'huge'],
            ['MOCK_SEED_EPOCH', 'yesterday'],
            ['MOCK_FAULTS', '{"errorRate":2}'],
            ['MOCK_FAULTS', '{"surprise":true}'],
            ['MOCK_DEV_LOGIN', 'yes'],
            ['MOCK_PASSKEYS', 'some'],
            ['MOCK_CONTROL', 'on'],
            ['MOCK_CONTROL_HOST', 'not a host'],
            ['MOCK_CONTROL_PORT', '70000'],
        ])('refuses %s=%s without echoing the value', (name, text) => {
            const problems = problemsOf({ ...BASE, [name]: text });
            expect(problems.length).toBeGreaterThan(0);
            expect(problems.every((problem) => problem.startsWith(`${name}: `))).toBe(true);
            if (text.length > 3) expect(problems.join(' ')).not.toContain(text);
        });

        it('keeps the seeded passkeys unless told the owner is still to come (M-08)', () => {
            expect(parseMockEngineConfig(BASE).passkeys).toBe('seeded');
            expect(parseMockEngineConfig({ ...BASE, MOCK_PASSKEYS: 'none' }).passkeys).toBe('none');
        });

        it('reads the capabilities and the simulation settings (M-07)', () => {
            expect(parseMockEngineConfig(BASE)).toMatchObject({
                capabilities: ['runs', 'files', 'triggers', 'integrations', 'test-chat'],
                simulation: { mode: 'running', speed: 1 },
            });
            expect(
                parseMockEngineConfig({
                    ...BASE,
                    MOCK_CAPABILITIES: ' runs , files,runs',
                    MOCK_SIMULATION: 'paused',
                    MOCK_SIMULATION_SPEED: '60.5',
                }),
            ).toMatchObject({ capabilities: ['runs', 'files'], simulation: { mode: 'paused', speed: 60.5 } });
            expect(parseMockEngineConfig({ ...BASE, MOCK_CAPABILITIES: 'none' }).capabilities).toEqual([]);
        });

        it.each([
            ['MOCK_CAPABILITIES', 'runs,chats'],
            ['MOCK_CAPABILITIES', 'runs@1'],
            ['MOCK_SIMULATION', 'fast'],
            ['MOCK_SIMULATION_SPEED', '0'],
            ['MOCK_SIMULATION_SPEED', '10000'],
            ['MOCK_SIMULATION_SPEED', '1e3'],
        ])('refuses %s=%s', (name, text) => {
            const problems = problemsOf({ ...BASE, [name]: text });
            expect(problems.length).toBeGreaterThan(0);
            expect(problems.every((problem) => problem.startsWith(`${name}: `))).toBe(true);
        });

        it('refuses the control listener and dev login in production', () => {
            expect(
                problemsOf({ ...BASE, NODE_ENV: 'production', MOCK_CONTROL: 'enabled', MOCK_DEV_LOGIN: 'enabled' }),
            ).toEqual([
                'MOCK_CONTROL: must not be enabled in production',
                'MOCK_DEV_LOGIN: must not be enabled in production',
            ]);
            expect(parseMockEngineConfig({ ...BASE, NODE_ENV: 'production' }).control).toBeNull();
            expect(
                parseMockEngineConfig({ ...BASE, NODE_ENV: 'development', MOCK_CONTROL: 'enabled' }).control,
            ).not.toBeNull();
        });
    });
    describe('UI loader', () => {
        const UI = {
            ...BASE,
            PTBK_UI_RELEASE_URL: 'https://releases.example.test/ptbk/',
            MOCK_UI_TRUST_POLICY_FILE: '/etc/ptbk/trust-policy.json',
        } as const;

        it('is off without PTBK_UI_RELEASE_URL', () => {
            expect(parseMockEngineConfig(BASE).ui).toBeNull();
        });

        it('defaults to auto, the pinned trusted root, Sigstore and an hourly check', () => {
            const config = parseMockEngineConfig(UI);
            expect(config.ui).toEqual({
                releaseUrl: 'https://releases.example.test/ptbk/',
                updatePolicy: { kind: 'auto' },
                trust: {
                    kind: 'files',
                    trustPolicyFile: '/etc/ptbk/trust-policy.json',
                    trustedRootFile: null,
                    fakeProvenance: false,
                },
                checkIntervalS: 3600,
            });
            expect(Object.isFrozen(config.ui)).toBe(true);
        });

        it('parses every setting', () => {
            expect(
                parseMockEngineConfig({
                    ...UI,
                    PTBK_UPDATE_POLICY: 'pinned',
                    PTBK_PINNED_VERSION: '0.0.0-dryrun.1',
                    MOCK_UI_CHECK_INTERVAL_S: '60',
                    MOCK_UI_FAKE_PROVENANCE: 'enabled',
                }).ui,
            ).toMatchObject({
                updatePolicy: { kind: 'pinned', version: '0.0.0-dryrun.1' },
                checkIntervalS: 60,
                trust: { fakeProvenance: true },
            });
            expect(parseMockEngineConfig({ ...UI, PTBK_UPDATE_POLICY: 'manual' }).ui?.updatePolicy).toEqual({
                kind: 'manual',
            });
            expect(parseMockEngineConfig({ ...UI, MOCK_UI_TRUSTED_ROOT_FILE: '/etc/root.json' }).ui).toMatchObject({
                trust: { trustedRootFile: '/etc/root.json' },
            });
        });

        it.each([
            ['http://releases.example.test/', 'PTBK_UI_RELEASE_URL'],
            ['https://releases.example.test/ptbk', 'PTBK_UI_RELEASE_URL'],
            ['https://user:pw@releases.example.test/', 'PTBK_UI_RELEASE_URL'],
            ['https://releases.example.test/?x', 'PTBK_UI_RELEASE_URL'],
        ])('refuses the release URL %s', (url, name) => {
            const problems = problemsOf({ ...UI, PTBK_UI_RELEASE_URL: url });
            expect(problems).toEqual([`${name}: must be an https:// URL without credentials whose path ends in /`]);
            expect(problems.join()).not.toContain('pw');
        });

        it.each([
            [{ PTBK_UPDATE_POLICY: 'sometimes' }, 'PTBK_UPDATE_POLICY: must be auto, manual or pinned'],
            [{ PTBK_UPDATE_POLICY: 'pinned' }, 'PTBK_PINNED_VERSION: is required with PTBK_UPDATE_POLICY=pinned'],
            [{ PTBK_PINNED_VERSION: '1.0.0' }, 'PTBK_PINNED_VERSION: needs PTBK_UPDATE_POLICY=pinned'],
            [
                { PTBK_UPDATE_POLICY: 'pinned', PTBK_PINNED_VERSION: '1.0' },
                'PTBK_PINNED_VERSION: must be a SemVer version',
            ],
            [
                { MOCK_UI_CHECK_INTERVAL_S: '0' },
                'MOCK_UI_CHECK_INTERVAL_S: must be a whole number of seconds from 1 to 86400',
            ],
            [
                { MOCK_UI_CHECK_INTERVAL_S: '86401' },
                'MOCK_UI_CHECK_INTERVAL_S: must be a whole number of seconds from 1 to 86400',
            ],
            [{ MOCK_UI_FAKE_PROVENANCE: 'yes' }, 'MOCK_UI_FAKE_PROVENANCE: must be enabled or disabled'],
            [
                { MOCK_UI_FAKE_PROVENANCE: 'enabled', MOCK_UI_TRUSTED_ROOT_FILE: '/r.json' },
                'MOCK_UI_TRUSTED_ROOT_FILE: has no effect with MOCK_UI_FAKE_PROVENANCE enabled',
            ],
        ])('refuses %j', (settings, problem) => {
            expect(problemsOf({ ...UI, ...settings })).toEqual([problem]);
        });

        it('needs a trust policy with a release URL, and a release URL for every other loader setting', () => {
            expect(problemsOf({ ...BASE, PTBK_UI_RELEASE_URL: 'https://releases.example.test/' })).toEqual([
                'MOCK_UI_TRUST_POLICY_FILE: is required with PTBK_UI_RELEASE_URL',
            ]);
            expect(problemsOf({ ...BASE, PTBK_UPDATE_POLICY: 'auto', MOCK_UI_FAKE_PROVENANCE: 'disabled' })).toEqual([
                'PTBK_UPDATE_POLICY: needs PTBK_UI_RELEASE_URL',
                'MOCK_UI_FAKE_PROVENANCE: needs PTBK_UI_RELEASE_URL',
            ]);
        });

        it('refuses fake provenance in production', () => {
            expect(problemsOf({ ...UI, NODE_ENV: 'production', MOCK_UI_FAKE_PROVENANCE: 'enabled' })).toEqual([
                'MOCK_UI_FAKE_PROVENANCE: must not be enabled in production',
            ]);
            expect(parseMockEngineConfig({ ...UI, NODE_ENV: 'production' }).ui?.trust).toMatchObject({
                fakeProvenance: false,
            });
        });

        describe('PTBK_CONFORMANCE_TRUST_FILE', () => {
            const CONFORMANCE = {
                ...BASE,
                PTBK_UI_RELEASE_URL: 'https://releases.example.test/ptbk/',
                PTBK_CONFORMANCE_TRUST_FILE: '/run/conformance/trust.json',
            } as const;

            it('replaces the trust policy and trusted root files', () => {
                const config = parseMockEngineConfig(CONFORMANCE);
                expect(config.ui?.trust).toEqual({ kind: 'conformance', file: '/run/conformance/trust.json' });
                expect(Object.isFrozen(config.ui?.trust)).toBe(true);
            });

            it('excludes every other trust setting', () => {
                expect(
                    problemsOf({
                        ...CONFORMANCE,
                        MOCK_UI_TRUST_POLICY_FILE: '/p.json',
                        MOCK_UI_TRUSTED_ROOT_FILE: '/r.json',
                        MOCK_UI_FAKE_PROVENANCE: 'disabled',
                    }),
                ).toEqual([
                    'MOCK_UI_TRUST_POLICY_FILE: cannot be set with PTBK_CONFORMANCE_TRUST_FILE',
                    'MOCK_UI_TRUSTED_ROOT_FILE: cannot be set with PTBK_CONFORMANCE_TRUST_FILE',
                    'MOCK_UI_FAKE_PROVENANCE: cannot be set with PTBK_CONFORMANCE_TRUST_FILE',
                ]);
            });

            it('needs a release URL', () => {
                expect(problemsOf({ ...BASE, PTBK_CONFORMANCE_TRUST_FILE: '/t.json' })).toEqual([
                    'PTBK_CONFORMANCE_TRUST_FILE: needs PTBK_UI_RELEASE_URL',
                ]);
            });

            it('is refused in production, with or without a release URL', () => {
                expect(problemsOf({ ...CONFORMANCE, NODE_ENV: 'production' })).toEqual([
                    'PTBK_CONFORMANCE_TRUST_FILE: must not be set in production',
                ]);
                expect(
                    problemsOf({ ...BASE, NODE_ENV: 'production', PTBK_CONFORMANCE_TRUST_FILE: '/t.json' }),
                ).toContain('PTBK_CONFORMANCE_TRUST_FILE: must not be set in production');
            });
        });
    });
});
