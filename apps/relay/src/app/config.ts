import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';

import type { Hostname, RelayId } from '@ptbk/protocol';
import {
    AUTH_TIMEOUT_MS,
    Hostname as HostnameSchema,
    MAX_FRAME_PAYLOAD_BYTES,
    RelayId as RelayIdSchema,
} from '@ptbk/protocol';
import { z } from 'zod';

import { isWithinDomain } from '../domain/engine-domain';
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
const MIB = 1_048_576;
/**
 * Sized for the 4 GB reference host until R-05 measures it: room for Node, sockets and TLS state beside the buffers.
 * Each open browser stream reserves 320 KiB of it, so about 3,300 streams fit.
 */
export const DEFAULT_MEMORY_BUDGET_BYTES = 1024 * MIB;

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

const RELAY_TOKEN = /^ptbk_rt_[A-Za-z0-9_-]{43}$/;
const RELAY_TOKEN_SHAPE = 'a relay token (ptbk_rt_ and 43 base64url characters)';
/** Not the registry token: whoever scrapes metrics must not be able to read the registry, and the reverse. */
const METRICS_TOKEN = /^ptbk_mt_[A-Za-z0-9_-]{43}$/;
const METRICS_TOKEN_SHAPE = 'a metrics token (ptbk_mt_ and 43 base64url characters)';
const MAX_TOKEN_FILE_BYTES = 1024;

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

/**
 * A token file, as systemd's `LoadCredential` provides it (I-01). Only a small regular file is read, so
 * a mistaken path such as a device or a directory fails instead of blocking startup.
 */
function readTokenFile(path: string): string | null {
    let fd: number | undefined;
    try {
        fd = openSync(path, 'r');
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_TOKEN_FILE_BYTES) return null;
        return readFileSync(fd, 'utf8');
    } catch {
        return null;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

const tokenFile = (pattern: RegExp, shape: string) =>
    filePath.transform((path, ctx): string => {
        const contents = readTokenFile(path);
        if (contents === null) {
            ctx.addIssue({
                code: 'custom',
                message: `must be a readable file of at most ${String(MAX_TOKEN_FILE_BYTES)} bytes`,
            });
            return z.NEVER;
        }
        // Files written by hand or by `echo` end with a newline; the token itself never contains whitespace.
        const token = contents.trimEnd();
        if (!pattern.test(token)) {
            ctx.addIssue({ code: 'custom', message: `must contain ${shape}` });
            return z.NEVER;
        }
        return token;
    });

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
    RELAY_REGISTRY_MISSES_PER_S: integer(1, MAX_CONNECTION_LIMIT).default(20),
    RELAY_TUNNEL_FRAMES_PER_S: integer(1, MAX_CONNECTION_LIMIT).default(20_000),
    RELAY_TUNNEL_MIN_WINDOW_INCREMENT_BYTES: integer(1, MAX_FRAME_PAYLOAD_BYTES).default(1024),
    RELAY_TUNNEL_PING_BUFFER_BYTES: integer(1, 64 * MIB).default(MIB),
    // At least the scheduler's high-water mark and a few frames, or ordinary traffic would trip it.
    RELAY_TUNNEL_MAX_BUFFERED_BYTES: integer(MIB, 1024 * MIB).default(8 * MIB),
    RELAY_CLIENT_HELLO_TIMEOUT_MS: integer(1, MAX_TIMEOUT_MS).default(5000),
    RELAY_CLIENT_HELLO_PRESSURE_TIMEOUT_MS: integer(1, MAX_TIMEOUT_MS).default(1000),
    RELAY_MAX_CONNECTIONS: integer(1, MAX_CONNECTION_LIMIT).default(10_000),
    RELAY_PENDING_CONNECTIONS_PERCENT: integer(1, 100).default(25),
    RELAY_RESERVED_CONNECTIONS_PERCENT: integer(0, 50).default(10),
    RELAY_MAX_CONNECTIONS_PER_IP: integer(1, MAX_CONNECTION_LIMIT).default(256),
    RELAY_MAX_CONNECTIONS_PER_IPV6_56: integer(1, MAX_CONNECTION_LIMIT).default(512),
    RELAY_MAX_CONNECTIONS_PER_IPV6_48: integer(1, MAX_CONNECTION_LIMIT).default(1024),
    RELAY_NEW_CONNECTIONS_PER_IP_PER_S: integer(1, MAX_CONNECTION_LIMIT).default(50),
    RELAY_MAX_STREAMS_PER_ENGINE: integer(1, MAX_CONNECTION_LIMIT).default(1024),
    RELAY_NEW_STREAMS_PER_ENGINE_PER_S: integer(1, MAX_CONNECTION_LIMIT).default(200),
    RELAY_ENGINE_BANDWIDTH_BYTES_PER_S: integer(1, MAX_BANDWIDTH_BYTES_PER_S).default(12_500_000),
    RELAY_STREAM_FIRST_BYTE_TIMEOUT_MS: integer(1, MAX_TIMEOUT_MS).default(10_000),
    RELAY_STREAM_DRAIN_TIMEOUT_MS: integer(1, MAX_TIMEOUT_MS).default(30_000),
    RELAY_STREAM_END_TIMEOUT_MS: integer(1, MAX_TIMEOUT_MS).default(30_000),
    RELAY_MEMORY_BUDGET_BYTES: integer(MIB, 8192 * MIB).default(DEFAULT_MEMORY_BUDGET_BYTES),
    RELAY_METRICS_TOKEN: value(z.string().regex(METRICS_TOKEN), `must be ${METRICS_TOKEN_SHAPE}`).optional(),
    RELAY_METRICS_TOKEN_FILE: tokenFile(METRICS_TOKEN, METRICS_TOKEN_SHAPE).optional(),
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
                RELAY_REGISTRY_TOKEN: value(z.string().regex(RELAY_TOKEN), `must be ${RELAY_TOKEN_SHAPE}`).optional(),
                RELAY_REGISTRY_TOKEN_FILE: tokenFile(RELAY_TOKEN, RELAY_TOKEN_SHAPE).optional(),
            }),
        ],
        { error: 'must be static or http' },
    )
    .superRefine((env, ctx) => {
        // Rule 1: a relay hostname among the engines' names would make the relay a TLS endpoint for one of them.
        if (isWithinDomain(env.RELAY_HOSTNAME, env.RELAY_ENGINE_DOMAIN)) {
            ctx.addIssue({
                code: 'custom',
                path: ['RELAY_HOSTNAME'],
                message: 'must not be RELAY_ENGINE_DOMAIN or a name under it',
            });
        }
        if (env.RELAY_METRICS_TOKEN !== undefined && env.RELAY_METRICS_TOKEN_FILE !== undefined) {
            ctx.addIssue({
                code: 'custom',
                path: ['RELAY_METRICS_TOKEN_FILE'],
                message: 'must not be set together with RELAY_METRICS_TOKEN',
            });
        }
        if (env.RELAY_REGISTRY_MAX_STALE_S < env.RELAY_REGISTRY_TTL_S) {
            ctx.addIssue({
                code: 'custom',
                path: ['RELAY_REGISTRY_MAX_STALE_S'],
                message: 'must be at least RELAY_REGISTRY_TTL_S',
            });
        }
    })
    .transform((env, ctx) => {
        if (env.RELAY_REGISTRY_KIND === 'static') return env;
        // Exactly one source, so a token left behind in the environment can never silently win over the file.
        const { RELAY_REGISTRY_TOKEN: inline, RELAY_REGISTRY_TOKEN_FILE: file, ...rest } = env;
        if (inline !== undefined && file !== undefined) {
            ctx.addIssue({
                code: 'custom',
                path: ['RELAY_REGISTRY_TOKEN_FILE'],
                message: 'must not be set together with RELAY_REGISTRY_TOKEN',
            });
            return z.NEVER;
        }
        const token = inline ?? file;
        if (token === undefined) {
            ctx.addIssue({
                code: 'custom',
                path: ['RELAY_REGISTRY_TOKEN'],
                message: 'is required, or RELAY_REGISTRY_TOKEN_FILE',
            });
            return z.NEVER;
        }
        return { ...rest, RELAY_REGISTRY_TOKEN: token };
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
        /** Connections between TCP accept and `ready`, relay-wide and per client IP (IPv6 per /64). */
        readonly maxPendingHandshakes: number;
        readonly maxPendingHandshakesPerIp: number;
        readonly maxTunnelsPerIp: number;
        /** Handshakes per second, relay-wide, whose engine is not in the registry cache. */
        readonly registryMissesPerS: number;
        /** Frames from one engine per second, of any kind. */
        readonly framesPerS: number;
        readonly minWindowIncrementBytes: number;
        /** Queued towards the engine: above the first, a ping is not answered; above the second, a send cuts it. */
        readonly pingBufferBytes: number;
        readonly maxBufferedBytes: number;
    };
    /** The listener on `listen.port`: every TCP connection, whichever way its SNI routes it. */
    readonly browser: {
        /** From TCP accept until the ClientHello can be judged; the second applies while pending connections crowd. */
        readonly clientHelloTimeoutMs: number;
        readonly pressureClientHelloTimeoutMs: number;
        /** Open connections, relay-wide, tunnels included. */
        readonly maxConnections: number;
        /** Of those, connections whose ClientHello is not judged yet (at least 1). */
        readonly maxPending: number;
        /** Of those, kept for the relay's own hostname: engine-bound connections may use the rest. */
        readonly reserved: number;
        /** Per IPv4 address and IPv6 /64; per IPv6 /56 and /48. */
        readonly maxConnectionsPerIp: number;
        readonly maxConnectionsPerIpv6Slash56: number;
        readonly maxConnectionsPerIpv6Slash48: number;
        readonly newConnectionsPerIpPerS: number;
        readonly maxStreamsPerEngine: number;
        readonly newStreamsPerEnginePerS: number;
        /** Both directions together. */
        readonly engineBandwidthBytesPerS: number;
        readonly firstByteTimeoutMs: number;
        readonly drainTimeoutMs: number;
        readonly endTimeoutMs: number;
    };
    /** Every byte the relay holds for others: data waiting for credit, queued frames, unflushed socket writes. */
    readonly memoryBudgetBytes: number;
    /** `GET /metrics` on the relay's own hostname answers only this bearer token; `null`: no metrics endpoint. */
    readonly metrics: { readonly token: Secret } | null;
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
    const maxConnections = parsed.RELAY_MAX_CONNECTIONS;
    const metricsToken = parsed.RELAY_METRICS_TOKEN ?? parsed.RELAY_METRICS_TOKEN_FILE;
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
            registryMissesPerS: parsed.RELAY_REGISTRY_MISSES_PER_S,
            framesPerS: parsed.RELAY_TUNNEL_FRAMES_PER_S,
            minWindowIncrementBytes: parsed.RELAY_TUNNEL_MIN_WINDOW_INCREMENT_BYTES,
            pingBufferBytes: parsed.RELAY_TUNNEL_PING_BUFFER_BYTES,
            maxBufferedBytes: parsed.RELAY_TUNNEL_MAX_BUFFERED_BYTES,
        }),
        browser: Object.freeze({
            clientHelloTimeoutMs: parsed.RELAY_CLIENT_HELLO_TIMEOUT_MS,
            pressureClientHelloTimeoutMs: parsed.RELAY_CLIENT_HELLO_PRESSURE_TIMEOUT_MS,
            maxConnections,
            maxPending: Math.max(1, Math.floor((maxConnections * parsed.RELAY_PENDING_CONNECTIONS_PERCENT) / 100)),
            reserved: Math.floor((maxConnections * parsed.RELAY_RESERVED_CONNECTIONS_PERCENT) / 100),
            maxConnectionsPerIp: parsed.RELAY_MAX_CONNECTIONS_PER_IP,
            maxConnectionsPerIpv6Slash56: parsed.RELAY_MAX_CONNECTIONS_PER_IPV6_56,
            maxConnectionsPerIpv6Slash48: parsed.RELAY_MAX_CONNECTIONS_PER_IPV6_48,
            newConnectionsPerIpPerS: parsed.RELAY_NEW_CONNECTIONS_PER_IP_PER_S,
            maxStreamsPerEngine: parsed.RELAY_MAX_STREAMS_PER_ENGINE,
            newStreamsPerEnginePerS: parsed.RELAY_NEW_STREAMS_PER_ENGINE_PER_S,
            engineBandwidthBytesPerS: parsed.RELAY_ENGINE_BANDWIDTH_BYTES_PER_S,
            firstByteTimeoutMs: parsed.RELAY_STREAM_FIRST_BYTE_TIMEOUT_MS,
            drainTimeoutMs: parsed.RELAY_STREAM_DRAIN_TIMEOUT_MS,
            endTimeoutMs: parsed.RELAY_STREAM_END_TIMEOUT_MS,
        }),
        memoryBudgetBytes: parsed.RELAY_MEMORY_BUDGET_BYTES,
        metrics: metricsToken === undefined ? null : Object.freeze({ token: secret(metricsToken) }),
        logLevel: parsed.LOG_LEVEL,
    });
}
