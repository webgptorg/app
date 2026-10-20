import type { EngineVersion, Hostname, RelayId } from '@ptbk/protocol';
import {
    EngineVersion as EngineVersionSchema,
    Hostname as HostnameSchema,
    MAX_RELAYS,
    RelayId as RelayIdSchema,
    TUNNEL_PATH,
} from '@ptbk/protocol';
import { z } from 'zod';

import packageJson from '../../package.json';
import type { NoProxyRule, ProxyConfig } from '../adapters/proxy-config';
import type { LogLevel } from '../domain/logger';
import { LOG_LEVELS } from '../domain/logger';
import { secret } from '../domain/secret';
import type { RelayTarget } from '../domain/tunnel/relay-target';

const MAX_PATH_LENGTH = 4096;
const MAX_URL_LENGTH = 2048;
const MAX_NO_PROXY_RULES = 256;
const WSS_DEFAULT_PORT = 443;
const HTTP_DEFAULT_PORT = 80;

const DEFAULT_ENGINE_VERSION: EngineVersion = EngineVersionSchema.parse(packageJson.version);

export interface MockEngineConfig {
    /** `PTBK_MODE`; the mock engine implements only `tunnel`. */
    readonly mode: 'tunnel';
    /** `PTBK_DATA_DIR`: holds `engine-key.pem`; must be private to the engine's user. */
    readonly dataDir: string;
    /** `PTBK_RELAYS`, in configured order, unique by relay ID. */
    readonly relays: readonly RelayTarget[];
    readonly engineDomain: Hostname;
    readonly engineVersion: EngineVersion;
    /** `HTTPS_PROXY` with `NO_PROXY`; null when no proxy is set. */
    readonly proxy: ProxyConfig | null;
    /** `MOCK_EXTRA_CA_FILE`: a PEM added to Node's default roots for relay connections. */
    readonly extraCaFile: string | null;
    readonly logLevel: LogLevel;
}

export interface IdentityConfig {
    readonly dataDir: string;
    readonly engineDomain: Hostname;
}

export class ConfigError extends Error {
    /** `NAME: problem` per setting; never a value, since `HTTPS_PROXY` may carry a password. */
    readonly problems: readonly string[];

    constructor(problems: readonly string[]) {
        super(`Invalid mock engine configuration: ${problems.join('; ')}`);
        this.name = 'ConfigError';
        this.problems = problems;
    }
}

/**
 * Parses a present env value with `schema`, reporting `message` instead of zod's text, which may quote the value.
 */
function value<S extends z.ZodType<unknown, string>>(schema: S, message: string) {
    return z.string({ error: 'is required' }).transform((input, ctx): z.output<S> => {
        const parsed = schema.safeParse(input);
        if (parsed.success) return parsed.data;
        ctx.addIssue({ code: 'custom', message });
        return z.NEVER;
    });
}

/** Like `value`, for parsers that report their own value-free problems. */
function parsed<T>(parse: (input: string, problem: (message: string) => void) => T | undefined) {
    return z.string({ error: 'is required' }).transform((input, ctx): T => {
        const problems: string[] = [];
        const result = parse(input, (message) => problems.push(message));
        for (const message of problems) ctx.addIssue({ code: 'custom', message });
        return problems.length > 0 || result === undefined ? z.NEVER : result;
    });
}

const filePath = value(
    z
        .string()
        .max(MAX_PATH_LENGTH)
        .regex(/^[^\0]+$/),
    'must be a file path',
);

function parseUrl(text: string): URL | undefined {
    // `?` and `#` with nothing after them leave `search` and `hash` empty, so the raw text is checked too.
    if (text.length > MAX_URL_LENGTH || /[?#]/.test(text)) return undefined;
    return URL.parse(text) ?? undefined;
}

function parsePort(port: string, fallback: number): number {
    return port === '' ? fallback : Number(port);
}

function parseRelay(entry: string): RelayTarget | string {
    const url = parseUrl(entry);
    if (url?.protocol !== 'wss:') return 'must be a wss:// URL without query or fragment';
    if (url.username !== '' || url.password !== '') return 'must not contain credentials';
    if (url.pathname !== '/' && url.pathname !== TUNNEL_PATH) return `must have no path or ${TUNNEL_PATH}`;
    const relayId = RelayIdSchema.safeParse(url.hostname);
    if (!relayId.success) return 'must name the relay by hostname, not an IP address';
    const port = parsePort(url.port, WSS_DEFAULT_PORT);
    const authority = port === WSS_DEFAULT_PORT ? relayId.data : `${relayId.data}:${String(port)}`;
    return Object.freeze({ url: `wss://${authority}${TUNNEL_PATH}`, relayId: relayId.data, port });
}

function parseRelays(list: string, problem: (message: string) => void): readonly RelayTarget[] | undefined {
    const entries = list.split(',').map((entry) => entry.trim());
    if (entries.length > MAX_RELAYS) {
        problem(`must list at most ${String(MAX_RELAYS)} relays`);
        return undefined;
    }
    const relays: RelayTarget[] = [];
    const seen = new Set<RelayId>();
    entries.forEach((entry, index) => {
        const relay = parseRelay(entry);
        if (typeof relay === 'string') {
            problem(`entry ${String(index + 1)} ${relay}`);
        } else if (seen.has(relay.relayId)) {
            problem(`entry ${String(index + 1)} repeats a relay`);
        } else {
            seen.add(relay.relayId);
            relays.push(relay);
        }
    });
    return Object.freeze(relays);
}

function decode(component: string): string | undefined {
    try {
        return decodeURIComponent(component);
    } catch {
        return undefined;
    }
}

function parseProxy(text: string, problem: (message: string) => void): Omit<ProxyConfig, 'noProxy'> | undefined {
    const url = parseUrl(text);
    if (url?.protocol === 'https:') {
        problem('https:// proxies are not supported; use an http:// proxy URL');
        return undefined;
    }
    if (url?.protocol !== 'http:' || url.hostname === '' || url.pathname !== '/') {
        problem('must be an http://[user:password@]host[:port] URL');
        return undefined;
    }
    const username = decode(url.username);
    const password = decode(url.password);
    if (username === undefined || password === undefined) {
        problem('has invalid percent-encoding in its credentials');
        return undefined;
    }
    const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    const credentials =
        username === '' && password === '' ? null : Object.freeze({ username, password: secret(password) });
    return { host, port: parsePort(url.port, HTTP_DEFAULT_PORT), credentials };
}

const NO_PROXY_HOST = /^[a-z0-9._-]+(?:\/\d{1,3})?$/;
const NO_PROXY_IPV6 = /^[0-9a-f:.]*:[0-9a-f:.]*:[0-9a-f:.]*(?:\/\d{1,3})?$/;

/** `""` → any port; otherwise `:<1..65535>`; anything else is invalid. */
function portSuffix(suffix: string): number | null | undefined {
    if (suffix === '') return null;
    if (!/^:\d{1,5}$/.test(suffix)) return undefined;
    const port = Number(suffix.slice(1));
    return port >= 1 && port <= 65_535 ? port : undefined;
}

function parseNoProxyRule(entry: string): NoProxyRule | undefined {
    if (entry === '*') return { host: '*', port: null };
    if (entry.startsWith('[')) {
        const close = entry.indexOf(']');
        const host = entry.slice(1, close);
        const port = portSuffix(entry.slice(close + 1));
        return close === -1 || port === undefined || !NO_PROXY_IPV6.test(host) ? undefined : { host, port };
    }
    if (NO_PROXY_IPV6.test(entry)) return { host: entry, port: null };
    const colon = entry.lastIndexOf(':');
    const name = colon === -1 ? entry : entry.slice(0, colon);
    const host = name.startsWith('.') ? name.slice(1) : name;
    const port = portSuffix(colon === -1 ? '' : entry.slice(colon));
    // IP and CIDR entries are accepted as written: relays are always hostnames, so they simply never match.
    if (port === undefined || !NO_PROXY_HOST.test(host)) return undefined;
    return { host, port };
}

function parseNoProxy(list: string, problem: (message: string) => void): readonly NoProxyRule[] | undefined {
    const entries = list
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry !== '');
    if (entries.length > MAX_NO_PROXY_RULES) {
        problem(`must list at most ${String(MAX_NO_PROXY_RULES)} entries`);
        return undefined;
    }
    const rules: NoProxyRule[] = [];
    entries.forEach((entry, index) => {
        const rule = parseNoProxyRule(entry);
        if (rule === undefined) problem(`entry ${String(index + 1)} must be *, a host or domain, or an IP address`);
        else rules.push(Object.freeze(rule));
    });
    return Object.freeze(rules);
}

const envSchema = z.strictObject({
    PTBK_MODE: value(z.literal('tunnel'), 'only tunnel is supported by the mock engine').default('tunnel'),
    PTBK_DATA_DIR: filePath,
    PTBK_RELAYS: parsed(parseRelays),
    PTBK_ENGINE_DOMAIN: value(HostnameSchema, 'must be a hostname'),
    PTBK_ENGINE_VERSION: value(EngineVersionSchema, 'must be a SemVer version').default(DEFAULT_ENGINE_VERSION),
    MOCK_EXTRA_CA_FILE: filePath.optional(),
    LOG_LEVEL: value(z.enum(LOG_LEVELS), `must be one of ${LOG_LEVELS.join(', ')}`).default('info'),
    HTTPS_PROXY: parsed(parseProxy).optional(),
    NO_PROXY: parsed(parseNoProxy).optional(),
});

const identitySchema = z.object({
    PTBK_DATA_DIR: filePath,
    PTBK_ENGINE_DOMAIN: value(HostnameSchema, 'must be a hostname'),
});

type Env = Readonly<Record<string, string | undefined>>;

/** Upper- and lowercase forms of the same proxy variable; tools disagree on precedence, so they must agree. */
const PROXY_VARIABLES = [
    ['HTTPS_PROXY', 'https_proxy'],
    ['NO_PROXY', 'no_proxy'],
] as const;

function isSetting(name: string): boolean {
    return name.startsWith('PTBK_') || name.startsWith('MOCK_') || name === 'LOG_LEVEL';
}

function present(env: Env, name: string): string | undefined {
    const setting = env[name];
    return setting === '' ? undefined : setting;
}

function toProblems(issue: z.core.$ZodIssue): string[] {
    if (issue.code === 'unrecognized_keys') {
        return issue.keys.map((key) => `${key}: is not a mock engine setting`);
    }
    return [`${issue.path.join('.')}: ${issue.message}`];
}

function settingsOf(env: Env, problems: string[]): Record<string, string> {
    const settings = Object.fromEntries(
        Object.keys(env)
            .filter(isSetting)
            .map((name) => [name, present(env, name)])
            .filter((setting): setting is [string, string] => setting[1] !== undefined),
    );
    for (const [upper, lower] of PROXY_VARIABLES) {
        const upperValue = present(env, upper);
        const lowerValue = present(env, lower);
        if (upperValue !== undefined && lowerValue !== undefined && upperValue !== lowerValue) {
            problems.push(`${upper}: differs from ${lower}; set only one`);
        }
        const chosen = upperValue ?? lowerValue;
        if (chosen !== undefined) settings[upper] = chosen;
    }
    return settings;
}

/**
 * The only reader of the environment for the engine process. Takes `PTBK_*`, `MOCK_*`, `LOG_LEVEL` and the proxy
 * variables, treats empty values as unset, rejects unknown `PTBK_*` and `MOCK_*` names, and throws {@link ConfigError}.
 */
export function parseMockEngineConfig(env: Env): MockEngineConfig {
    const problems: string[] = [];
    const settings = settingsOf(env, problems);
    const result = envSchema.safeParse(settings);
    if (!result.success) problems.push(...result.error.issues.flatMap(toProblems));
    if (!result.success || problems.length > 0) throw new ConfigError(problems);
    const parsedEnv = result.data;
    const proxy =
        parsedEnv.HTTPS_PROXY === undefined
            ? null
            : Object.freeze({ ...parsedEnv.HTTPS_PROXY, noProxy: parsedEnv.NO_PROXY ?? Object.freeze([]) });
    return Object.freeze({
        mode: parsedEnv.PTBK_MODE,
        dataDir: parsedEnv.PTBK_DATA_DIR,
        relays: parsedEnv.PTBK_RELAYS,
        engineDomain: parsedEnv.PTBK_ENGINE_DOMAIN,
        engineVersion: parsedEnv.PTBK_ENGINE_VERSION,
        proxy,
        extraCaFile: parsedEnv.MOCK_EXTRA_CA_FILE ?? null,
        logLevel: parsedEnv.LOG_LEVEL,
    });
}

/**
 * For the `identity` CLI, which runs in the engine's environment but needs only the data directory and the engine
 * domain: every other variable is ignored, so a CLI run never fails on settings it does not use.
 */
export function parseIdentityConfig(env: Env): IdentityConfig {
    const result = identitySchema.safeParse({
        PTBK_DATA_DIR: present(env, 'PTBK_DATA_DIR'),
        PTBK_ENGINE_DOMAIN: present(env, 'PTBK_ENGINE_DOMAIN'),
    });
    if (!result.success) throw new ConfigError(result.error.issues.flatMap(toProblems));
    return Object.freeze({ dataDir: result.data.PTBK_DATA_DIR, engineDomain: result.data.PTBK_ENGINE_DOMAIN });
}
