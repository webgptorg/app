import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

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

const URL_PROBLEM =
    'RELAY_REGISTRY_URL: must be an https URL (http only on 127.0.0.1, ::1 or localhost) without credentials, query or fragment';

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
            listen: { host: '0.0.0.0', port: 443, backlog: 511 },
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
            tunnel: {
                handshakeTimeoutMs: 10_000,
                maxPendingHandshakes: 1000,
                maxPendingHandshakesPerIp: 10,
                maxTunnelsPerIp: 50,
                registryMissesPerS: 20,
                framesPerS: 20_000,
                minWindowIncrementBytes: 1024,
                pingBufferBytes: 1_048_576,
                maxBufferedBytes: 8_388_608,
            },
            browser: {
                clientHelloTimeoutMs: 5000,
                pressureClientHelloTimeoutMs: 1000,
                maxConnections: 10_000,
                maxPending: 2500,
                reserved: 1000,
                maxConnectionsPerIp: 256,
                maxConnectionsPerIpv6Slash56: 512,
                maxConnectionsPerIpv6Slash48: 1024,
                newConnectionsPerIpPerS: 50,
                maxStreamsPerEngine: 1024,
                newStreamsPerEnginePerS: 200,
                engineBandwidthBytesPerS: 12_500_000,
                firstByteTimeoutMs: 10_000,
                drainTimeoutMs: 30_000,
                endTimeoutMs: 30_000,
            },
            memoryBudgetBytes: 1_073_741_824,
            metrics: null,
            imageDigest: null,
            logLevel: 'info',
        });
        expect(Object.isFrozen(config)).toBe(true);
        expect(Object.isFrozen(config.tunnel)).toBe(true);
        expect(Object.isFrozen(config.browser)).toBe(true);
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
            RELAY_LISTEN_BACKLOG: '8192',
            RELAY_REGISTRY_TIMEOUT_MS: '500',
            RELAY_REGISTRY_TTL_S: '60',
            RELAY_REGISTRY_MAX_STALE_S: '3600',
            RELAY_DNS_SERVERS: '1.1.1.1, 2606:4700:4700::1111',
            RELAY_DNS_TIMEOUT_MS: '1000',
            RELAY_TUNNEL_HANDSHAKE_TIMEOUT_MS: '5000',
            RELAY_MAX_PENDING_HANDSHAKES: '200',
            RELAY_MAX_PENDING_HANDSHAKES_PER_IP: '4',
            RELAY_MAX_TUNNELS_PER_IP: '8',
            RELAY_CLIENT_HELLO_TIMEOUT_MS: '2000',
            RELAY_MAX_CONNECTIONS: '5000',
            RELAY_MAX_CONNECTIONS_PER_IP: '64',
            RELAY_NEW_CONNECTIONS_PER_IP_PER_S: '20',
            RELAY_MAX_STREAMS_PER_ENGINE: '512',
            RELAY_NEW_STREAMS_PER_ENGINE_PER_S: '100',
            RELAY_ENGINE_BANDWIDTH_BYTES_PER_S: '1250000000',
            RELAY_REGISTRY_MISSES_PER_S: '5',
            RELAY_TUNNEL_FRAMES_PER_S: '1000',
            RELAY_TUNNEL_MIN_WINDOW_INCREMENT_BYTES: '512',
            RELAY_TUNNEL_PING_BUFFER_BYTES: '65536',
            RELAY_TUNNEL_MAX_BUFFERED_BYTES: '2097152',
            RELAY_CLIENT_HELLO_PRESSURE_TIMEOUT_MS: '500',
            RELAY_PENDING_CONNECTIONS_PERCENT: '10',
            RELAY_RESERVED_CONNECTIONS_PERCENT: '0',
            RELAY_MAX_CONNECTIONS_PER_IPV6_56: '128',
            RELAY_MAX_CONNECTIONS_PER_IPV6_48: '256',
            RELAY_STREAM_FIRST_BYTE_TIMEOUT_MS: '5000',
            RELAY_STREAM_DRAIN_TIMEOUT_MS: '6000',
            RELAY_STREAM_END_TIMEOUT_MS: '7000',
            RELAY_MEMORY_BUDGET_BYTES: '268435456',
            RELAY_IMAGE_DIGEST: `sha256:${'0f'.repeat(32)}`,
            LOG_LEVEL: 'warn',
        });
        expect(config.relayId).toBe('relay-a.ptbk.test');
        expect(config.engineDomain).toBe('engine.test');
        expect(config.listen).toEqual({ host: '::', port: 0, backlog: 8192 });
        expect(config.registry).toMatchObject({ timeoutMs: 500, ttlMs: 60_000, maxStaleMs: 3_600_000 });
        expect(config.dns).toEqual({ servers: ['1.1.1.1', '2606:4700:4700::1111'], timeoutMs: 1000 });
        expect(Object.isFrozen(config.dns.servers)).toBe(true);
        expect(config.tunnel).toEqual({
            handshakeTimeoutMs: 5000,
            maxPendingHandshakes: 200,
            maxPendingHandshakesPerIp: 4,
            maxTunnelsPerIp: 8,
            registryMissesPerS: 5,
            framesPerS: 1000,
            minWindowIncrementBytes: 512,
            pingBufferBytes: 65_536,
            maxBufferedBytes: 2_097_152,
        });
        expect(config.browser).toEqual({
            clientHelloTimeoutMs: 2000,
            pressureClientHelloTimeoutMs: 500,
            maxConnections: 5000,
            maxPending: 500,
            reserved: 0,
            maxConnectionsPerIp: 64,
            maxConnectionsPerIpv6Slash56: 128,
            maxConnectionsPerIpv6Slash48: 256,
            newConnectionsPerIpPerS: 20,
            maxStreamsPerEngine: 512,
            newStreamsPerEnginePerS: 100,
            engineBandwidthBytesPerS: 1_250_000_000,
            firstByteTimeoutMs: 5000,
            drainTimeoutMs: 6000,
            endTimeoutMs: 7000,
        });
        expect(config.memoryBudgetBytes).toBe(268_435_456);
        expect(config.imageDigest).toBe(`sha256:${'0f'.repeat(32)}`);
        expect(config.logLevel).toBe('warn');
    });

    it('has no setting that could hold an engine key or certificate', () => {
        // The relay holds public keys only (AGENTS.md rule 1): its only key is its own TLS key.
        const config = parseRelayConfig(staticEnv);
        const paths: string[] = [];
        const walk = (value: unknown, path: string): void => {
            if (typeof value !== 'object' || value === null) return;
            for (const [key, child] of Object.entries(value)) {
                paths.push(`${path}${key}`);
                walk(child, `${path}${key}.`);
            }
        };
        walk(config, '');
        expect(paths.filter((path) => /key|cert|secret|private|engine/i.test(path))).toEqual([
            'engineDomain',
            'tls.certFile',
            'tls.keyFile',
            // Per-engine limits, not engine material.
            'browser.maxStreamsPerEngine',
            'browser.newStreamsPerEnginePerS',
            'browser.engineBandwidthBytesPerS',
        ]);
        for (const name of ['RELAY_ENGINE_KEY_FILE', 'RELAY_ENGINE_CERT_FILE', 'RELAY_ENGINE_PRIVATE_KEY']) {
            expect(configError({ ...staticEnv, [name]: '/etc/engine/key.pem' }).problems).toEqual([
                `${name}: is not a setting for this RELAY_REGISTRY_KIND`,
            ]);
        }
    });

    it('keeps at least one pending slot however small the cap', () => {
        const config = parseRelayConfig({
            ...staticEnv,
            RELAY_MAX_CONNECTIONS: '3',
            RELAY_PENDING_CONNECTIONS_PERCENT: '1',
            RELAY_RESERVED_CONNECTIONS_PERCENT: '50',
        });
        expect([config.browser.maxPending, config.browser.reserved]).toEqual([1, 1]);
    });

    it.each(['engine.test', 'relay.engine.test', 'Relay.Engine.TEST'])(
        'refuses a relay hostname %s inside the engine domain (it would terminate TLS for engines)',
        (hostname) => {
            expect(configError({ ...staticEnv, RELAY_HOSTNAME: hostname }).problems).toEqual([
                'RELAY_HOSTNAME: must not be RELAY_ENGINE_DOMAIN or a name under it',
            ]);
        },
    );

    it('accepts a relay hostname that only shares a suffix with the engine domain', () => {
        expect(parseRelayConfig({ ...staticEnv, RELAY_HOSTNAME: 'relay.xengine.test' }).relayId).toBe(
            'relay.xengine.test',
        );
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
            'RELAY_REGISTRY_TOKEN: is required, or RELAY_REGISTRY_TOKEN_FILE',
        ],
        ['http with a non-http URL', { ...httpEnv, RELAY_REGISTRY_URL: 'ftp://app.ptbk.test' }, URL_PROBLEM],
        [
            'http with a cleartext URL to a remote host',
            { ...httpEnv, RELAY_REGISTRY_URL: 'http://dashboard.example' },
            URL_PROBLEM,
        ],
        [
            'http with a cleartext URL to a name that only starts like loopback',
            { ...httpEnv, RELAY_REGISTRY_URL: 'http://127.0.0.1.dashboard.example' },
            URL_PROBLEM,
        ],
        [
            'http with a cleartext URL to a localhost subdomain',
            { ...httpEnv, RELAY_REGISTRY_URL: 'http://localhost.dashboard.example' },
            URL_PROBLEM,
        ],
        [
            'http with credentials in the URL',
            { ...httpEnv, RELAY_REGISTRY_URL: 'https://relay:secret@app.ptbk.test' },
            URL_PROBLEM,
        ],
        [
            'http with a query in the URL',
            { ...httpEnv, RELAY_REGISTRY_URL: 'https://app.ptbk.test/?token=x' },
            URL_PROBLEM,
        ],
        [
            'http with a fragment in the URL',
            { ...httpEnv, RELAY_REGISTRY_URL: 'https://app.ptbk.test/#x' },
            URL_PROBLEM,
        ],
        ['http with something that is not a URL', { ...httpEnv, RELAY_REGISTRY_URL: 'app.ptbk.test' }, URL_PROBLEM],
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
            'a zero listen backlog',
            { ...staticEnv, RELAY_LISTEN_BACKLOG: '0' },
            'RELAY_LISTEN_BACKLOG: must be an integer from 1 to 65535',
        ],
        [
            'a listen backlog above 65535',
            { ...staticEnv, RELAY_LISTEN_BACKLOG: '65536' },
            'RELAY_LISTEN_BACKLOG: must be an integer from 1 to 65535',
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
        [
            'a zero handshake timeout',
            { ...staticEnv, RELAY_TUNNEL_HANDSHAKE_TIMEOUT_MS: '0' },
            'RELAY_TUNNEL_HANDSHAKE_TIMEOUT_MS: must be an integer from 1 to 60000',
        ],
        [
            'a zero pending-handshake limit',
            { ...staticEnv, RELAY_MAX_PENDING_HANDSHAKES: '0' },
            'RELAY_MAX_PENDING_HANDSHAKES: must be an integer from 1 to 1000000',
        ],
        [
            'a non-numeric per-IP pending-handshake limit',
            { ...staticEnv, RELAY_MAX_PENDING_HANDSHAKES_PER_IP: 'ten' },
            'RELAY_MAX_PENDING_HANDSHAKES_PER_IP: must be an integer from 1 to 1000000',
        ],
        [
            'a per-IP tunnel limit above the maximum',
            { ...staticEnv, RELAY_MAX_TUNNELS_PER_IP: '1000001' },
            'RELAY_MAX_TUNNELS_PER_IP: must be an integer from 1 to 1000000',
        ],
        [
            'a zero ClientHello timeout',
            { ...staticEnv, RELAY_CLIENT_HELLO_TIMEOUT_MS: '0' },
            'RELAY_CLIENT_HELLO_TIMEOUT_MS: must be an integer from 1 to 60000',
        ],
        [
            'a non-numeric global connection limit',
            { ...staticEnv, RELAY_MAX_CONNECTIONS: 'many' },
            'RELAY_MAX_CONNECTIONS: must be an integer from 1 to 1000000',
        ],
        [
            'a zero per-IP connection limit',
            { ...staticEnv, RELAY_MAX_CONNECTIONS_PER_IP: '0' },
            'RELAY_MAX_CONNECTIONS_PER_IP: must be an integer from 1 to 1000000',
        ],
        [
            'a fractional per-IP connection rate',
            { ...staticEnv, RELAY_NEW_CONNECTIONS_PER_IP_PER_S: '0.5' },
            'RELAY_NEW_CONNECTIONS_PER_IP_PER_S: must be an integer from 1 to 1000000',
        ],
        [
            'a per-engine stream limit above the maximum',
            { ...staticEnv, RELAY_MAX_STREAMS_PER_ENGINE: '1000001' },
            'RELAY_MAX_STREAMS_PER_ENGINE: must be an integer from 1 to 1000000',
        ],
        [
            'a negative per-engine stream rate',
            { ...staticEnv, RELAY_NEW_STREAMS_PER_ENGINE_PER_S: '-1' },
            'RELAY_NEW_STREAMS_PER_ENGINE_PER_S: must be an integer from 1 to 1000000',
        ],
        [
            'an engine bandwidth above 10 Gbit/s',
            { ...staticEnv, RELAY_ENGINE_BANDWIDTH_BYTES_PER_S: '1250000001' },
            'RELAY_ENGINE_BANDWIDTH_BYTES_PER_S: must be an integer from 1 to 1250000000',
        ],
        [
            'a pending share of 0%',
            { ...staticEnv, RELAY_PENDING_CONNECTIONS_PERCENT: '0' },
            'RELAY_PENDING_CONNECTIONS_PERCENT: must be an integer from 1 to 100',
        ],
        [
            'a reserve above half the cap',
            { ...staticEnv, RELAY_RESERVED_CONNECTIONS_PERCENT: '51' },
            'RELAY_RESERVED_CONNECTIONS_PERCENT: must be an integer from 0 to 50',
        ],
        [
            'a tunnel send cap below 1 MiB',
            { ...staticEnv, RELAY_TUNNEL_MAX_BUFFERED_BYTES: '1048575' },
            'RELAY_TUNNEL_MAX_BUFFERED_BYTES: must be an integer from 1048576 to 1073741824',
        ],
        [
            'a minimum window increment above one frame',
            { ...staticEnv, RELAY_TUNNEL_MIN_WINDOW_INCREMENT_BYTES: '65537' },
            'RELAY_TUNNEL_MIN_WINDOW_INCREMENT_BYTES: must be an integer from 1 to 65536',
        ],
        [
            'a memory budget above 8 GiB',
            { ...staticEnv, RELAY_MEMORY_BUDGET_BYTES: '8589934593' },
            'RELAY_MEMORY_BUDGET_BYTES: must be an integer from 1048576 to 8589934592',
        ],
        ['an unknown LOG_LEVEL', { ...staticEnv, LOG_LEVEL: 'debug' }, 'LOG_LEVEL: must be one of info, warn, error'],
        [
            'an image digest that is not a sha256 digest',
            { ...staticEnv, RELAY_IMAGE_DIGEST: 'ghcr.io/webgptorg/relay:latest' },
            'RELAY_IMAGE_DIGEST: must be sha256:<64 hex digits>',
        ],
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

    it.each(['http://127.0.0.1:8787', 'http://[::1]:8787', 'http://localhost:8787', 'https://app.ptbk.test/api'])(
        'accepts the registry URL %s',
        (url) => {
            const config = parseRelayConfig({ ...httpEnv, RELAY_REGISTRY_URL: url });
            expect(config.registry.kind === 'http' && config.registry.url).toBe(url);
        },
    );

    it.each<[string, Record<string, string>, string]>([
        [
            'a valid token beside a cleartext remote URL',
            { ...httpEnv, RELAY_REGISTRY_URL: 'http://dashboard.example' },
            TOKEN,
        ],
        [
            'a token inside the URL credentials',
            { ...httpEnv, RELAY_REGISTRY_URL: `https://relay:${TOKEN}@app.ptbk.test` },
            TOKEN,
        ],
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

    describe('RELAY_REGISTRY_TOKEN_FILE', () => {
        const dir = mkdtempSync(join(tmpdir(), 'relay-config-'));
        afterAll(() => {
            rmSync(dir, { recursive: true, force: true });
        });

        function tokenFile(name: string, contents: string): string {
            const path = join(dir, name);
            writeFileSync(path, contents, { mode: 0o600 });
            return path;
        }

        const fileEnv = (path: string): Record<string, string> => ({
            ...without(httpEnv, 'RELAY_REGISTRY_TOKEN'),
            RELAY_REGISTRY_TOKEN_FILE: path,
        });

        it.each([
            ['a bare token', TOKEN],
            ['a token and a newline', `${TOKEN}\n`],
            ['a token and CRLF', `${TOKEN}\r\n`],
        ])('reads %s from the file and keeps it redacted', (_, contents) => {
            const config = parseRelayConfig(fileEnv(tokenFile('token', contents)));
            if (config.registry.kind !== 'http') throw new Error('expected the http registry');
            expect(config.registry.token.reveal()).toBe(TOKEN);
            expect(JSON.stringify(config)).not.toContain(TOKEN);
            expect(inspect(config, { depth: 10 })).not.toContain(TOKEN);
        });

        it('refuses the file together with RELAY_REGISTRY_TOKEN', () => {
            const error = configError({ ...httpEnv, RELAY_REGISTRY_TOKEN_FILE: tokenFile('both', TOKEN) });
            expect(error.problems).toEqual([
                'RELAY_REGISTRY_TOKEN_FILE: must not be set together with RELAY_REGISTRY_TOKEN',
            ]);
            expect(error.message).not.toContain(TOKEN);
        });

        it('requires one of the two', () => {
            expect(configError(without(httpEnv, 'RELAY_REGISTRY_TOKEN')).problems).toEqual([
                'RELAY_REGISTRY_TOKEN: is required, or RELAY_REGISTRY_TOKEN_FILE',
            ]);
        });

        it('treats an empty RELAY_REGISTRY_TOKEN_FILE as unset', () => {
            expect(configError(fileEnv('')).problems).toEqual([
                'RELAY_REGISTRY_TOKEN: is required, or RELAY_REGISTRY_TOKEN_FILE',
            ]);
        });

        it.each([
            ['a missing file', () => join(dir, 'missing')],
            ['a directory', () => dir],
            ['a file over 1 KiB', () => tokenFile('large', `${TOKEN}\n${' '.repeat(1024)}`)],
        ])('refuses %s', (_, path) => {
            expect(configError(fileEnv(path())).problems).toEqual([
                'RELAY_REGISTRY_TOKEN_FILE: must be a readable file of at most 1024 bytes',
            ]);
        });

        it.each([
            ['a malformed token', 'ptbk_rt_short'],
            ['two tokens', `${TOKEN}\n${TOKEN}`],
            ['a token after a blank line', `\n${TOKEN}`],
            ['an empty file', ''],
        ])('refuses %s without quoting the file', (name, contents) => {
            const error = configError(fileEnv(tokenFile(name.replaceAll(' ', '-'), contents)));
            expect(error.problems).toEqual([
                'RELAY_REGISTRY_TOKEN_FILE: must contain a relay token (ptbk_rt_ and 43 base64url characters)',
            ]);
            if (contents !== '') expect(error.message).not.toContain(contents.trim().split('\n')[0]);
        });

        it('reports a bad file beside other problems', () => {
            const error = configError({ ...fileEnv(join(dir, 'missing')), RELAY_LISTEN_PORT: 'x' });
            expect(error.problems).toEqual([
                'RELAY_LISTEN_PORT: must be an integer from 0 to 65535',
                'RELAY_REGISTRY_TOKEN_FILE: must be a readable file of at most 1024 bytes',
            ]);
        });

        it('is not a setting of the static registry', () => {
            expect(
                configError({ ...staticEnv, RELAY_REGISTRY_TOKEN_FILE: tokenFile('static', TOKEN) }).problems,
            ).toEqual(['RELAY_REGISTRY_TOKEN_FILE: is not a setting for this RELAY_REGISTRY_KIND']);
        });
    });

    describe('RELAY_METRICS_TOKEN', () => {
        const METRICS_TOKEN = `ptbk_mt_${'m'.repeat(43)}`;
        const dir = mkdtempSync(join(tmpdir(), 'relay-metrics-config-'));
        afterAll(() => {
            rmSync(dir, { recursive: true, force: true });
        });
        const file = (contents: string): string => {
            const path = join(dir, 'metrics-token');
            writeFileSync(path, contents, { mode: 0o600 });
            return path;
        };

        it('leaves the metrics endpoint off when unset', () => {
            expect(parseRelayConfig(staticEnv).metrics).toBeNull();
        });

        it.each([
            ['the variable', () => ({ RELAY_METRICS_TOKEN: METRICS_TOKEN })],
            ['a file', () => ({ RELAY_METRICS_TOKEN_FILE: file(`${METRICS_TOKEN}\n`) })],
        ])('reads the token from %s with either registry kind and keeps it redacted', (_, extra) => {
            for (const env of [staticEnv, httpEnv]) {
                const config = parseRelayConfig({ ...env, ...extra() });
                expect(config.metrics?.token.reveal()).toBe(METRICS_TOKEN);
                expect(JSON.stringify(config)).not.toContain(METRICS_TOKEN);
                expect(inspect(config, { depth: 10 })).not.toContain(METRICS_TOKEN);
            }
        });

        it('refuses the registry token as a metrics token, without quoting it', () => {
            const error = configError({ ...staticEnv, RELAY_METRICS_TOKEN: TOKEN });
            expect(error.problems).toEqual([
                'RELAY_METRICS_TOKEN: must be a metrics token (ptbk_mt_ and 43 base64url characters)',
            ]);
            expect(error.message).not.toContain(TOKEN);
            expect(configError({ ...staticEnv, RELAY_METRICS_TOKEN_FILE: file(TOKEN) }).problems).toEqual([
                'RELAY_METRICS_TOKEN_FILE: must contain a metrics token (ptbk_mt_ and 43 base64url characters)',
            ]);
        });

        it('refuses both sources at once', () => {
            expect(
                configError({
                    ...staticEnv,
                    RELAY_METRICS_TOKEN: METRICS_TOKEN,
                    RELAY_METRICS_TOKEN_FILE: file(METRICS_TOKEN),
                }).problems,
            ).toEqual(['RELAY_METRICS_TOKEN_FILE: must not be set together with RELAY_METRICS_TOKEN']);
        });
    });
});
