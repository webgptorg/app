import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { ConfigError, MAX_REGISTRY_STALE_S, parseRelayConfig } from './config';

const TOKEN = `ptbk_rt_${'A'.repeat(21)}-_${'z'.repeat(20)}`;

const staticEnv: Readonly<Record<string, string>> = {
    RELAY_HOSTNAME: 'relay-a.ptbk.test',
    RELAY_ENGINE_DOMAIN: 'engine.test',
    RELAY_TLS_CERT_FILE: '/etc/relay/cert.pem',
    RELAY_TLS_KEY_FILE: '/etc/relay/key.pem',
    RELAY_REGISTRY_KIND: 'static',
    RELAY_REGISTRY_FILE: '/etc/relay/registry.json',
};

const httpEnv: Readonly<Record<string, string>> = {
    ...without(staticEnv, 'RELAY_REGISTRY_FILE'),
    RELAY_REGISTRY_KIND: 'http',
    RELAY_REGISTRY_URL: 'https://app.ptbk.test',
    RELAY_REGISTRY_TOKEN: TOKEN,
};

function without(env: Readonly<Record<string, string>>, ...names: string[]): Record<string, string> {
    return Object.fromEntries(Object.entries(env).filter(([name]) => !names.includes(name)));
}

function configError(env: Readonly<Record<string, string | undefined>>): ConfigError {
    try {
        parseRelayConfig(env);
    } catch (error) {
        if (error instanceof ConfigError) return error;
        throw error;
    }
    throw new Error('expected a ConfigError');
}

describe('parseRelayConfig', () => {
    it('parses a static env into a frozen config with defaults', () => {
        const config = parseRelayConfig({ ...staticEnv, PATH: '/usr/bin', HOME: '/root', RELAY_LISTEN_HOST: '' });
        expect(config).toEqual({
            relayId: 'relay-a.ptbk.test',
            listen: { host: '0.0.0.0', port: 443 },
            engineDomain: 'engine.test',
            tls: { certFile: '/etc/relay/cert.pem', keyFile: '/etc/relay/key.pem' },
            registry: {
                kind: 'static',
                file: '/etc/relay/registry.json',
                timeoutMs: 3000,
                ttlMs: 300_000,
                maxStaleMs: 86_400_000,
            },
            dns: { servers: null, timeoutMs: 3000 },
            logLevel: 'info',
        });
        expect(Object.isFrozen(config)).toBe(true);
        expect(Object.isFrozen(config.listen)).toBe(true);
        expect(Object.isFrozen(config.tls)).toBe(true);
        expect(Object.isFrozen(config.registry)).toBe(true);
        expect(Object.isFrozen(config.dns)).toBe(true);
    });

    it('lowercases hostnames and reads every optional setting', () => {
        const config = parseRelayConfig({
            ...staticEnv,
            RELAY_HOSTNAME: 'Relay-A.PTBK.test',
            RELAY_ENGINE_DOMAIN: 'Engine.TEST',
            RELAY_LISTEN_HOST: '::',
            RELAY_LISTEN_PORT: '0',
            RELAY_REGISTRY_TIMEOUT_MS: '500',
            RELAY_REGISTRY_TTL_S: '60',
            RELAY_REGISTRY_MAX_STALE_S: '3600',
            RELAY_DNS_SERVERS: '1.1.1.1, 2606:4700:4700::1111',
            RELAY_DNS_TIMEOUT_MS: '1000',
            LOG_LEVEL: 'warn',
        });
        expect(config.relayId).toBe('relay-a.ptbk.test');
        expect(config.engineDomain).toBe('engine.test');
        expect(config.listen).toEqual({ host: '::', port: 0 });
        expect(config.registry).toMatchObject({ timeoutMs: 500, ttlMs: 60_000, maxStaleMs: 3_600_000 });
        expect(config.dns).toEqual({ servers: ['1.1.1.1', '2606:4700:4700::1111'], timeoutMs: 1000 });
        expect(Object.isFrozen(config.dns.servers)).toBe(true);
        expect(config.logLevel).toBe('warn');
    });

    it('allows the stale window to equal the TTL and reach the 24-hour ceiling', () => {
        const config = parseRelayConfig({
            ...staticEnv,
            RELAY_REGISTRY_TTL_S: String(MAX_REGISTRY_STALE_S),
            RELAY_REGISTRY_MAX_STALE_S: String(MAX_REGISTRY_STALE_S),
        });
        expect(config.registry.maxStaleMs).toBe(config.registry.ttlMs);
    });

    it('parses an http env and keeps the token out of every rendering of the config', () => {
        const config = parseRelayConfig(httpEnv);
        if (config.registry.kind !== 'http') throw new Error('expected the http registry');
        expect(config.registry.url).toBe('https://app.ptbk.test');
        expect(config.registry.token.reveal()).toBe(TOKEN);
        expect(String(config.registry.token as unknown)).toBe('[redacted]');
        expect(JSON.stringify(config)).not.toContain(TOKEN);
        expect(inspect(config, { depth: 10 })).not.toContain(TOKEN);
        expect(inspect(config, { depth: 10 })).toContain('[redacted]');
    });

    it.each<[string, Record<string, string>, string]>([
        ['RELAY_HOSTNAME missing', without(staticEnv, 'RELAY_HOSTNAME'), 'RELAY_HOSTNAME: is required'],
        ['RELAY_ENGINE_DOMAIN missing', without(staticEnv, 'RELAY_ENGINE_DOMAIN'), 'RELAY_ENGINE_DOMAIN: is required'],
        ['RELAY_TLS_CERT_FILE missing', without(staticEnv, 'RELAY_TLS_CERT_FILE'), 'RELAY_TLS_CERT_FILE: is required'],
        ['RELAY_TLS_KEY_FILE missing', without(staticEnv, 'RELAY_TLS_KEY_FILE'), 'RELAY_TLS_KEY_FILE: is required'],
        ['RELAY_REGISTRY_FILE missing', without(staticEnv, 'RELAY_REGISTRY_FILE'), 'RELAY_REGISTRY_FILE: is required'],
        ['RELAY_REGISTRY_FILE empty', { ...staticEnv, RELAY_REGISTRY_FILE: '' }, 'RELAY_REGISTRY_FILE: is required'],
        [
            'RELAY_REGISTRY_FILE with a NUL',
            { ...staticEnv, RELAY_REGISTRY_FILE: 'a\0b' },
            'RELAY_REGISTRY_FILE: must be a file path',
        ],
        [
            'RELAY_REGISTRY_KIND missing',
            without(staticEnv, 'RELAY_REGISTRY_KIND'),
            'RELAY_REGISTRY_KIND: must be static or http',
        ],
        [
            'RELAY_REGISTRY_KIND unknown',
            { ...staticEnv, RELAY_REGISTRY_KIND: 'ftp' },
            'RELAY_REGISTRY_KIND: must be static or http',
        ],
        ['http without RELAY_REGISTRY_URL', without(httpEnv, 'RELAY_REGISTRY_URL'), 'RELAY_REGISTRY_URL: is required'],
        [
            'http without RELAY_REGISTRY_TOKEN',
            without(httpEnv, 'RELAY_REGISTRY_TOKEN'),
            'RELAY_REGISTRY_TOKEN: is required',
        ],
        [
            'http with a non-http URL',
            { ...httpEnv, RELAY_REGISTRY_URL: 'ftp://app.ptbk.test' },
            'RELAY_REGISTRY_URL: must be an http or https URL',
        ],
        [
            'static with RELAY_REGISTRY_URL',
            { ...staticEnv, RELAY_REGISTRY_URL: 'https://app.ptbk.test' },
            'RELAY_REGISTRY_URL: is not a setting for this RELAY_REGISTRY_KIND',
        ],
        [
            'http with RELAY_REGISTRY_FILE',
            { ...httpEnv, RELAY_REGISTRY_FILE: '/etc/relay/registry.json' },
            'RELAY_REGISTRY_FILE: is not a setting for this RELAY_REGISTRY_KIND',
        ],
        [
            'an unknown RELAY_ setting',
            { ...staticEnv, RELAY_FOO: '1' },
            'RELAY_FOO: is not a setting for this RELAY_REGISTRY_KIND',
        ],
        [
            'a non-numeric port',
            { ...staticEnv, RELAY_LISTEN_PORT: 'https' },
            'RELAY_LISTEN_PORT: must be an integer from 0 to 65535',
        ],
        [
            'a port with trailing letters',
            { ...staticEnv, RELAY_LISTEN_PORT: '44a' },
            'RELAY_LISTEN_PORT: must be an integer from 0 to 65535',
        ],
        [
            'a port above 65535',
            { ...staticEnv, RELAY_LISTEN_PORT: '65536' },
            'RELAY_LISTEN_PORT: must be an integer from 0 to 65535',
        ],
        [
            'a negative port',
            { ...staticEnv, RELAY_LISTEN_PORT: '-1' },
            'RELAY_LISTEN_PORT: must be an integer from 0 to 65535',
        ],
        [
            'a listen host that is not an IP',
            { ...staticEnv, RELAY_LISTEN_HOST: 'localhost' },
            'RELAY_LISTEN_HOST: must be an IP address',
        ],
        [
            'an invalid relay hostname',
            { ...staticEnv, RELAY_HOSTNAME: 'relay_a.ptbk.test' },
            'RELAY_HOSTNAME: must be a hostname',
        ],
        [
            'an IP as engine domain',
            { ...staticEnv, RELAY_ENGINE_DOMAIN: '10.0.0.1' },
            'RELAY_ENGINE_DOMAIN: must be a hostname',
        ],
        [
            'a stale window above 24 hours',
            { ...staticEnv, RELAY_REGISTRY_MAX_STALE_S: '86401' },
            'RELAY_REGISTRY_MAX_STALE_S: must be an integer from 1 to 86400',
        ],
        [
            'a stale window shorter than the TTL',
            { ...staticEnv, RELAY_REGISTRY_TTL_S: '600', RELAY_REGISTRY_MAX_STALE_S: '300' },
            'RELAY_REGISTRY_MAX_STALE_S: must be at least RELAY_REGISTRY_TTL_S',
        ],
        [
            'a zero timeout',
            { ...staticEnv, RELAY_REGISTRY_TIMEOUT_MS: '0' },
            'RELAY_REGISTRY_TIMEOUT_MS: must be an integer from 1 to 60000',
        ],
        ['an unknown LOG_LEVEL', { ...staticEnv, LOG_LEVEL: 'debug' }, 'LOG_LEVEL: must be one of info, warn, error'],
        [
            'a DNS server given by name',
            { ...staticEnv, RELAY_DNS_SERVERS: 'dns.google' },
            'RELAY_DNS_SERVERS: must be a comma-separated list of 1 to 8 IP addresses',
        ],
        [
            'a DNS list with one name among IPs',
            { ...staticEnv, RELAY_DNS_SERVERS: '1.1.1.1,example.com' },
            'RELAY_DNS_SERVERS: must be a comma-separated list of 1 to 8 IP addresses',
        ],
        [
            'more than 8 DNS servers',
            { ...staticEnv, RELAY_DNS_SERVERS: Array.from({ length: 9 }, (_, i) => `10.0.0.${String(i + 1)}`).join() },
            'RELAY_DNS_SERVERS: must be a comma-separated list of 1 to 8 IP addresses',
        ],
    ])('rejects %s', (_, env, problem) => {
        const error = configError(env);
        expect(error.problems).toContain(problem);
        expect(error.message).toBe(`Invalid relay configuration: ${error.problems.join('; ')}`);
    });

    it('reports every problem at once', () => {
        const error = configError({ ...without(staticEnv, 'RELAY_HOSTNAME'), RELAY_LISTEN_PORT: 'x' });
        expect(error.problems).toEqual([
            'RELAY_HOSTNAME: is required',
            'RELAY_LISTEN_PORT: must be an integer from 0 to 65535',
        ]);
    });

    it.each<[string, Record<string, string>, string]>([
        ['a malformed token', { ...httpEnv, RELAY_REGISTRY_TOKEN: 'ptbk_rt_short' }, 'ptbk_rt_short'],
        ['a token without the prefix', { ...httpEnv, RELAY_REGISTRY_TOKEN: 'A'.repeat(51) }, 'A'.repeat(51)],
        ['a valid token beside a missing URL', without(httpEnv, 'RELAY_REGISTRY_URL'), TOKEN],
        ['a valid token beside a bad port', { ...httpEnv, RELAY_LISTEN_PORT: '99999' }, TOKEN],
        ['a valid token beside a file setting', { ...httpEnv, RELAY_REGISTRY_FILE: '/x' }, TOKEN],
        ['a valid token with the static kind', { ...httpEnv, RELAY_REGISTRY_KIND: 'static' }, TOKEN],
        ['a valid token with an unknown kind', { ...httpEnv, RELAY_REGISTRY_KIND: 'ftp' }, TOKEN],
    ])('never puts the token into the error for %s', (_, env, token) => {
        const error = configError(env);
        expect(error.problems.length).toBeGreaterThan(0);
        expect(error.message).not.toContain(token);
        expect(JSON.stringify(error)).not.toContain(token);
        expect(inspect(error)).not.toContain(token);
    });

    it('names a malformed token without quoting it', () => {
        expect(configError({ ...httpEnv, RELAY_REGISTRY_TOKEN: 'ptbk_rt_short' }).problems).toEqual([
            'RELAY_REGISTRY_TOKEN: must be a relay token (ptbk_rt_ and 43 base64url characters)',
        ]);
    });
});
