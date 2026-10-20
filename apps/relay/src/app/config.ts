import type { Hostname, RelayId } from '@ptbk/protocol';
import { AUTH_TIMEOUT_MS, Hostname as HostnameSchema, RelayId as RelayIdSchema } from '@ptbk/protocol';
import { z } from 'zod';

import type { LogLevel } from '../domain/logger';
import { LOG_LEVELS } from '../domain/logger';

/** The decided ceiling (2026-10-19): a suspension takes effect within 24 hours even during a dashboard outage. */
export const MAX_REGISTRY_STALE_S = 86_400;
const MAX_DNS_SERVERS = 8;
const MAX_PATH_LENGTH = 4096;
const MAX_TIMEOUT_MS = 60_000;
const MAX_CONNECTION_LIMIT = 1_000_000;
/** 10 Gbit/s: more than any relay host's NIC. */
const MAX_BANDWIDTH_BYTES_PER_S = 1_250_000_000;

/** A secret that never shows up in `JSON.stringify`, `String()` or `util.inspect`. */
export interface Secret {
    reveal(): string;
}

function secret(value: string): Secret {
    const redacted = (): string => '[redacted]';
    return Object.freeze({
        reveal: () => value,
        toString: redacted,
        toJSON: redacted,
        [Symbol.for('nodejs.util.inspect.custom')]: redacted,
    });
}

/**
 * Parses a present env value with `schema`, reporting `message` instead of zod's text, which may quote the value
 * (and one of them is a token).
 */
function value<S extends z.ZodType<unknown, string>>(schema: S, message: string) {
    return z.string({ error: 'is required' }).transform((input, ctx): z.output<S> => {
        const parsed = schema.safeParse(input);
        if (parsed.success) return parsed.data;
        ctx.addIssue({ code: 'custom', message });
        return z.NEVER;
    });
}

function integer(min: number, max: number) {
    return value(
        z
            .string()
            .regex(/^\d{1,10}$/)
            .transform(Number)
            .pipe(z.number().int().min(min).max(max)),
        `must be an integer from ${String(min)} to ${String(max)}`,
    );
}

const ipAddress = z.union([z.ipv4(), z.ipv6()]);

// The relay token travels as a bearer header, so cleartext is allowed only to this machine (local dev without TLS).
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost']);

const registryUrl = z.string().refine((input) => {
    if (/[?#]/.test(input) || !URL.canParse(input)) return false;
    const url = new URL(input);
    const transport = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
    return transport && url.username === '' && url.password === '';
});
const filePath = value(
    z
        .string()
        .max(MAX_PATH_LENGTH)
        .regex(/^[^\0]+$/),
    'must be a file path',
);

const common = {
    RELAY_HOSTNAME: value(RelayIdSchema, 'must be a hostname'),
    RELAY_LISTEN_HOST: value(ipAddress, 'must be an IP address').default('0.0.0.0'),
    RELAY_LISTEN_PORT: integer(0, 65_535).default(443),
    RELAY_ENGINE_DOMAIN: value(HostnameSchema, 'must be a hostname'),
    RELAY_TLS_CERT_FILE: filePath,
    RELAY_TLS_KEY_FILE: filePath,
    RELAY_REGISTRY_TIMEOUT_MS: integer(1, MAX_TIMEOUT_MS).default(3000),
    RELAY_REGISTRY_TTL_S: integer(1, MAX_REGISTRY_STALE_S).default(300),
    RELAY_REGISTRY_MAX_STALE_S: integer(1, MAX_REGISTRY_STALE_S).default(MAX_REGISTRY_STALE_S),
    RELAY_DNS_SERVERS: value(
        z
            .string()
            .transform((list) => list.split(',').map((server) => server.trim()))
            .pipe(z.array(ipAddress).min(1).max(MAX_DNS_SERVERS)),
        `must be a comma-separated list of 1 to ${String(MAX_DNS_SERVERS)} IP addresses`,
    ).optional(),
    RELAY_DNS_TIMEOUT_MS: integer(1, MAX_TIMEOUT_MS).default(3000),
    RELAY_TUNNEL_HANDSHAKE_TIMEOUT_MS: integer(1, MAX_TIMEOUT_MS).default(AUTH_TIMEOUT_MS),
    RELAY_MAX_PENDING_HANDSHAKES: integer(1, MAX_CONNECTION_LIMIT).default(1000),
    RELAY_MAX_PENDING_HANDSHAKES_PER_IP: integer(1, MAX_CONNECTION_LIMIT).default(10),
    RELAY_MAX_TUNNELS_PER_IP: integer(1, MAX_CONNECTION_LIMIT).default(50),
    RELAY_CLIENT_HELLO_TIMEOUT_MS: integer(1, MAX_TIMEOUT_MS).default(5000),
    RELAY_MAX_CONNECTIONS: integer(1, MAX_CONNECTION_LIMIT).default(10_000),
    RELAY_MAX_CONNECTIONS_PER_IP: integer(1, MAX_CONNECTION_LIMIT).default(256),
    RELAY_NEW_CONNECTIONS_PER_IP_PER_S: integer(1, MAX_CONNECTION_LIMIT).default(50),
    RELAY_MAX_STREAMS_PER_ENGINE: integer(1, MAX_CONNECTION_LIMIT).default(1024),
    RELAY_NEW_STREAMS_PER_ENGINE_PER_S: integer(1, MAX_CONNECTION_LIMIT).default(200),
    RELAY_ENGINE_BANDWIDTH_BYTES_PER_S: integer(1, MAX_BANDWIDTH_BYTES_PER_S).default(12_500_000),
    LOG_LEVEL: value(z.enum(LOG_LEVELS), `must be one of ${LOG_LEVELS.join(', ')}`).default('info'),
};

const envSchema = z
    .discriminatedUnion(
        'RELAY_REGISTRY_KIND',
        [
            z.strictObject({
                ...common,
                RELAY_REGISTRY_KIND: z.literal('static'),
                RELAY_REGISTRY_FILE: filePath,
            }),
            z.strictObject({
                ...common,
                RELAY_REGISTRY_KIND: z.literal('http'),
                RELAY_REGISTRY_URL: value(
                    registryUrl,
                    'must be an https URL (http only on 127.0.0.1, ::1 or localhost) without credentials, query or fragment',
                ),
                RELAY_REGISTRY_TOKEN: value(
                    z.string().regex(/^ptbk_rt_[A-Za-z0-9_-]{43}$/),
                    'must be a relay token (ptbk_rt_ and 43 base64url characters)',
                ),
            }),
        ],
        { error: 'must be static or http' },
    )
    .superRefine((env, ctx) => {
        if (env.RELAY_REGISTRY_MAX_STALE_S < env.RELAY_REGISTRY_TTL_S) {
            ctx.addIssue({
                code: 'custom',
                path: ['RELAY_REGISTRY_MAX_STALE_S'],
                message: 'must be at least RELAY_REGISTRY_TTL_S',
            });
        }
    });

export type RegistryConfig =
    | { readonly kind: 'static'; readonly file: string }
    | { readonly kind: 'http'; readonly url: string; readonly token: Secret };

export interface RelayConfig {
    /** `RELAY_HOSTNAME`: the only name the relay terminates TLS for, and the `relayId` in tunnel challenges. */
    readonly relayId: RelayId;
    readonly listen: { readonly host: string; readonly port: number };
    readonly engineDomain: Hostname;
    /** Paths to the relay's own certificate and key; never an engine's. */
    readonly tls: { readonly certFile: string; readonly keyFile: string };
    readonly registry: RegistryConfig & {
        readonly timeoutMs: number;
        readonly ttlMs: number;
        readonly maxStaleMs: number;
    };
    /** `servers: null` uses the system resolvers. */
    readonly dns: { readonly servers: readonly string[] | null; readonly timeoutMs: number };
    readonly tunnel: {
        /** From TCP accept to `ready`. */
        readonly handshakeTimeoutMs: number;
        /** Connections between TCP accept and `ready`, relay-wide and per client IP. */
        readonly maxPendingHandshakes: number;
        readonly maxPendingHandshakesPerIp: number;
        readonly maxTunnelsPerIp: number;
    };
    /** The listener on `listen.port`: every TCP connection, whichever way its SNI routes it. */
    readonly browser: {
        /** From TCP accept until the ClientHello can be judged. */
        readonly clientHelloTimeoutMs: number;
        /** Open connections, relay-wide and per client IP (IPv6 per /64). */
        readonly maxConnections: number;
        readonly maxConnectionsPerIp: number;
        readonly newConnectionsPerIpPerS: number;
        readonly maxStreamsPerEngine: number;
        readonly newStreamsPerEnginePerS: number;
        /** Both directions together. */
        readonly engineBandwidthBytesPerS: number;
    };
    readonly logLevel: LogLevel;
}

export class ConfigError extends Error {
    /** `NAME: problem` per setting; never a value. */
    readonly problems: readonly string[];

    constructor(problems: readonly string[]) {
        super(`Invalid relay configuration: ${problems.join('; ')}`);
        this.name = 'ConfigError';
        this.problems = problems;
    }
}

function isRelaySetting(name: string): boolean {
    return name.startsWith('RELAY_') || name === 'LOG_LEVEL';
}

function toProblems(issue: z.core.$ZodIssue): string[] {
    if (issue.code === 'unrecognized_keys') {
        return issue.keys.map((key) => `${key}: is not a setting for this RELAY_REGISTRY_KIND`);
    }
    return [`${issue.path.join('.')}: ${issue.message}`];
}

/**
 * The only reader of the environment. Takes `RELAY_*` and `LOG_LEVEL`, treats empty values as unset, rejects unknown
 * `RELAY_*` names, and throws {@link ConfigError}.
 */
export function parseRelayConfig(env: Readonly<Record<string, string | undefined>>): RelayConfig {
    const settings = Object.fromEntries(
        Object.entries(env).filter(
            (setting): setting is [string, string] =>
                isRelaySetting(setting[0]) && setting[1] !== undefined && setting[1] !== '',
        ),
    );
    const result = envSchema.safeParse(settings);
    if (!result.success) throw new ConfigError(result.error.issues.flatMap(toProblems));
    const parsed = result.data;
    const registry: RegistryConfig =
        parsed.RELAY_REGISTRY_KIND === 'static'
            ? { kind: 'static', file: parsed.RELAY_REGISTRY_FILE }
            : { kind: 'http', url: parsed.RELAY_REGISTRY_URL, token: secret(parsed.RELAY_REGISTRY_TOKEN) };
    return Object.freeze({
        relayId: parsed.RELAY_HOSTNAME,
        listen: Object.freeze({ host: parsed.RELAY_LISTEN_HOST, port: parsed.RELAY_LISTEN_PORT }),
        engineDomain: parsed.RELAY_ENGINE_DOMAIN,
        tls: Object.freeze({ certFile: parsed.RELAY_TLS_CERT_FILE, keyFile: parsed.RELAY_TLS_KEY_FILE }),
        registry: Object.freeze({
            ...registry,
            timeoutMs: parsed.RELAY_REGISTRY_TIMEOUT_MS,
            ttlMs: parsed.RELAY_REGISTRY_TTL_S * 1000,
            maxStaleMs: parsed.RELAY_REGISTRY_MAX_STALE_S * 1000,
        }),
        dns: Object.freeze({
            servers: parsed.RELAY_DNS_SERVERS === undefined ? null : Object.freeze(parsed.RELAY_DNS_SERVERS),
            timeoutMs: parsed.RELAY_DNS_TIMEOUT_MS,
        }),
        tunnel: Object.freeze({
            handshakeTimeoutMs: parsed.RELAY_TUNNEL_HANDSHAKE_TIMEOUT_MS,
            maxPendingHandshakes: parsed.RELAY_MAX_PENDING_HANDSHAKES,
            maxPendingHandshakesPerIp: parsed.RELAY_MAX_PENDING_HANDSHAKES_PER_IP,
            maxTunnelsPerIp: parsed.RELAY_MAX_TUNNELS_PER_IP,
        }),
        browser: Object.freeze({
            clientHelloTimeoutMs: parsed.RELAY_CLIENT_HELLO_TIMEOUT_MS,
            maxConnections: parsed.RELAY_MAX_CONNECTIONS,
            maxConnectionsPerIp: parsed.RELAY_MAX_CONNECTIONS_PER_IP,
            newConnectionsPerIpPerS: parsed.RELAY_NEW_CONNECTIONS_PER_IP_PER_S,
            maxStreamsPerEngine: parsed.RELAY_MAX_STREAMS_PER_ENGINE,
            newStreamsPerEnginePerS: parsed.RELAY_NEW_STREAMS_PER_ENGINE_PER_S,
            engineBandwidthBytesPerS: parsed.RELAY_ENGINE_BANDWIDTH_BYTES_PER_S,
        }),
        logLevel: parsed.LOG_LEVEL,
    });
}
