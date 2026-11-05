import type { EngineVersion, Hostname, LinkCode, RelayId } from '@ptbk/protocol';
import {
    EngineVersion as EngineVersionSchema,
    Hostname as HostnameSchema,
    LinkCode as LinkCodeSchema,
    MAX_RELAYS,
    RelayId as RelayIdSchema,
    TUNNEL_PATH,
} from '@ptbk/protocol';
import { z } from 'zod';

import packageJson from '../../package.json';
import type { DevCaFiles } from '../adapters/dev-ca';
import type { FaultPlan } from '../domain/faults/fault-plan';
import { NO_FAULTS, parseFaultPlanJson } from '../domain/faults/fault-plan';
import { DEFAULT_HEARTBEAT_INTERVAL_S } from '../domain/heartbeat/heartbeat-loop';
import type { NoProxyRule, ProxyConfig } from '../adapters/proxy-config';
import type { LogLevel } from '../domain/logger';
import { LOG_LEVELS } from '../domain/logger';
import type { OneTimeSecret } from '../domain/secret';
import { oneTimeSecret, secret } from '../domain/secret';
import { MAX_SIMULATION_SPEED, MIN_SIMULATION_SPEED } from '../domain/simulation/simulation-clock';
import type { SimulationMode } from '../domain/simulation/simulation-clock';
import { MOCK_PROFILES, PROFILE_CAPABILITY_NAMES, parseCapabilityList } from '../domain/state/capabilities';
import type { MockCapabilityName } from '../domain/state/capabilities';
import { Scenario } from '../domain/state/scenarios';
import type { RelayTarget } from '../domain/tunnel/relay-target';
import { DEFAULT_UI_CHECK_INTERVAL_S } from '../domain/ui/ui-updater';
import type { UpdatePolicy } from '../domain/ui/update-policy';

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
    /**
     * `PTBK_RELAYS`, in configured order, unique by relay ID; empty when unset. When set, it replaces the relays from
     * the registration: an operator-trusted override (launch contract), safe because relays never see plaintext.
     */
    readonly relays: readonly RelayTarget[];
    readonly engineDomain: Hostname;
    readonly engineVersion: EngineVersion;
    /** `HTTPS_PROXY` with `NO_PROXY`; null when no proxy is set. */
    readonly proxy: ProxyConfig | null;
    /** `MOCK_EXTRA_CA_FILE`: a PEM added to Node's default roots for relay connections. */
    readonly extraCaFile: string | null;
    /** `MOCK_DEV_CA_CERT_FILE` and `MOCK_DEV_CA_KEY_FILE` (both or neither); null generates a CA in the data dir. */
    readonly devCaFiles: DevCaFiles | null;
    /** `MOCK_DEV_CA_DOMAINS`: e2e domains a generated dev CA permits besides the engine domain. */
    readonly devCaDomains: readonly Hostname[];
    /** `MOCK_CERT_SOURCE`: where the engine's own TLS certificates come from. */
    readonly certificateSource: CertificateSourceConfig;
    readonly logLevel: LogLevel;
    /** `MOCK_SEED`, `MOCK_SCENARIO` and `MOCK_SEED_EPOCH`: the same three give the same engine state. */
    readonly seed: number;
    readonly scenario: Scenario;
    readonly seedEpoch: Date;
    /** `MOCK_FAULTS`, a JSON `FaultPlan`; changeable at runtime through the control listener. */
    readonly faults: FaultPlan;
    /**
     * `MOCK_CAPABILITIES`: what `GET /engine` advertises. Without it, `MOCK_PROFILE` decides: `reborn` (the default)
     * advertises only what the Reborn engine has, `full` every capability but `file-scanning`.
     */
    readonly capabilities: readonly MockCapabilityName[];
    /** `MOCK_SIMULATION` and `MOCK_SIMULATION_SPEED`: whether engine time runs on its own, and how fast. */
    readonly simulation: { readonly mode: SimulationMode; readonly speed: number };
    /** `MOCK_DEV_LOGIN=enabled`: the sign-in page lets anyone pick a member. Refused with `NODE_ENV=production`. */
    readonly devLogin: boolean;
    /** `MOCK_PASSKEYS`: `seeded` (the owner is set up) or `none` (a fresh engine that waits for its owner). */
    readonly passkeys: 'seeded' | 'none';
    /** `MOCK_ONBOARDING`: `pending` or `completed`; without it `empty` is pending and the other scenarios completed. */
    readonly onboarding: 'pending' | 'completed' | null;
    /** `MOCK_CONTROL=enabled` with `MOCK_CONTROL_HOST` and `MOCK_CONTROL_PORT`; refused with `NODE_ENV=production`. */
    readonly control: { readonly host: string; readonly port: number } | null;
    /** `PTBK_DASHBOARD_URL` and what goes with it; null runs the M1 dev mode on `PTBK_RELAYS`, without heartbeats. */
    readonly dashboard: DashboardConfig | null;
    /** `MOCK_STATS`: the heartbeat's disk, memory and CPU figures from the host (`os`) or fixed per scenario. */
    readonly stats: 'os' | 'scenario';
    /** The UI loader (M-05); null without `PTBK_UI_RELEASE_URL`, and the engine answers 503 for the app. */
    readonly ui: UiLoaderConfig | null;
}

export type CertificateSourceConfig =
    | { readonly kind: 'dev-ca' }
    | {
          readonly kind: 'acme';
          /** `PTBK_ACME_DIRECTORY_URL`. */
          readonly directoryUrl: string;
          /** `PTBK_ACME_EMAIL`: the account's contact, if any. */
          readonly email: string | null;
      };

export interface UiLoaderConfig {
    /** `PTBK_UI_RELEASE_URL`: the release store or mirror, `https://` with a path ending in `/`. */
    readonly releaseUrl: string;
    /** `PTBK_UPDATE_POLICY` with `PTBK_PINNED_VERSION`. */
    readonly updatePolicy: UpdatePolicy;
    readonly trust: UiTrustConfig;
    /** `MOCK_UI_CHECK_INTERVAL_S`, default 3600. */
    readonly checkIntervalS: number;
}

/** Where the loader's trust policy and Sigstore trusted root come from. */
export type UiTrustConfig =
    | {
          readonly kind: 'files';
          /** `MOCK_UI_TRUST_POLICY_FILE`: C-06's `TrustPolicy` as JSON. */
          readonly trustPolicyFile: string;
          /** `MOCK_UI_TRUSTED_ROOT_FILE`; null uses the pinned Sigstore trusted root. */
          readonly trustedRootFile: string | null;
          /**
           * `MOCK_UI_FAKE_PROVENANCE=enabled`: test attestations instead of Sigstore. Refused with `NODE_ENV=production`.
           */
          readonly fakeProvenance: boolean;
      }
    | {
          readonly kind: 'conformance';
          /**
           * `PTBK_CONFORMANCE_TRUST_FILE`: the conformance suite's `ConformanceTrustFile` (trust policy and trusted
           * root, verified with the real Sigstore verifier), as a conformance build of the engine reads it. Excludes the
           * `MOCK_UI_*` trust settings; refused with `NODE_ENV=production`.
           */
          readonly file: string;
      };

export interface DashboardConfig {
    /** The dashboard's `https://` origin. */
    readonly url: string;
    /** `PTBK_LINK_CODE`: taken once, for the first registration, and never logged or written down. */
    readonly linkCode: OneTimeSecret<LinkCode> | null;
    /** `MOCK_HEARTBEAT_INTERVAL_S`, default 60. */
    readonly heartbeatIntervalS: number;
}

export interface IdentityConfig {
    readonly dataDir: string;
    readonly engineDomain: Hostname;
}

export interface DevCaConfig extends IdentityConfig {
    /** `MOCK_DEV_CA_DOMAINS`: what the CA permits besides the engine domain, and the only names `issue` accepts. */
    readonly devCaDomains: readonly Hostname[];
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

/** An `https://` URL without credentials, query or fragment, whose path ends in `/` so store paths join under it. */
function parseReleaseUrl(text: string, problem: (message: string) => void): string | undefined {
    const url = parseUrl(text);
    if (url?.protocol !== 'https:' || url.username !== '' || url.password !== '' || !url.pathname.endsWith('/')) {
        problem('must be an https:// URL without credentials whose path ends in /');
        return undefined;
    }
    return url.href;
}

/** An `https://` origin: no credentials, path, query or fragment, so it joins with the contract's paths unambiguously. */
function parseDashboardUrl(text: string, problem: (message: string) => void): string | undefined {
    const url = parseUrl(text);
    if (url?.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.pathname !== '/') {
        problem('must be an https:// origin without credentials or path');
        return undefined;
    }
    return url.origin;
}

/** An `https://` URL without credentials or fragment: ACME directories may have a path and query of their own. */
function parseAcmeDirectoryUrl(text: string, problem: (message: string) => void): string | undefined {
    const url = text.length > MAX_URL_LENGTH ? undefined : URL.parse(text);
    if (url?.protocol !== 'https:' || url.username !== '' || url.password !== '' || text.includes('#')) {
        problem('must be an https:// URL without credentials or fragment');
        return undefined;
    }
    return url.href;
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

const MAX_DEV_CA_DOMAINS = 16;

function parseDomains(list: string, problem: (message: string) => void): readonly Hostname[] | undefined {
    const entries = list
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');
    if (entries.length > MAX_DEV_CA_DOMAINS) {
        problem(`must list at most ${String(MAX_DEV_CA_DOMAINS)} domains`);
        return undefined;
    }
    const domains: Hostname[] = [];
    entries.forEach((entry, index) => {
        const domain = HostnameSchema.safeParse(entry);
        if (domain.success) domains.push(domain.data);
        else problem(`entry ${String(index + 1)} must be a hostname`);
    });
    return Object.freeze(domains);
}

const MAX_SEED = 2 ** 32 - 1;
const DEFAULT_SEED_EPOCH = '2026-10-01T00:00:00Z';
const toggle = value(z.enum(['enabled', 'disabled']), 'must be enabled or disabled');

const envSchema = z.strictObject({
    NODE_ENV: z.string().max(64).optional(),
    MOCK_SEED: value(
        z
            .string()
            .regex(/^(?:0|[1-9]\d{0,9})$/)
            .transform(Number)
            .pipe(z.int().max(MAX_SEED)),
        `must be an integer from 0 to ${String(MAX_SEED)}`,
    ).default(1),
    MOCK_SCENARIO: value(Scenario, `must be one of ${Scenario.options.join(', ')}`).default('small-team'),
    MOCK_SEED_EPOCH: value(
        z.iso.datetime({ offset: false }).transform((text) => new Date(text)),
        'must be an RFC 3339 UTC timestamp',
    ).default(new Date(DEFAULT_SEED_EPOCH)),
    MOCK_FAULTS: parsed((text, problem) => {
        const result = parseFaultPlanJson(text);
        if (result.kind === 'ok') return result.plan;
        for (const message of result.problems) problem(`must be a fault plan (${message})`);
        return undefined;
    }).optional(),
    MOCK_CAPABILITIES: parsed(parseCapabilityList).optional(),
    MOCK_PROFILE: value(z.enum(MOCK_PROFILES), `must be ${MOCK_PROFILES.join(' or ')}`).default('reborn'),
    MOCK_SIMULATION: value(z.enum(['running', 'paused']), 'must be running or paused').default('running'),
    MOCK_SIMULATION_SPEED: value(
        z
            .string()
            .regex(/^\d{1,4}(?:\.\d{1,3})?$/)
            .transform(Number)
            .pipe(z.number().min(MIN_SIMULATION_SPEED).max(MAX_SIMULATION_SPEED)),
        `must be a number from ${String(MIN_SIMULATION_SPEED)} to ${String(MAX_SIMULATION_SPEED)}`,
    ).default(1),
    MOCK_DEV_LOGIN: toggle.default('disabled'),
    MOCK_PASSKEYS: value(z.enum(['seeded', 'none']), 'must be seeded or none').default('seeded'),
    MOCK_ONBOARDING: value(z.enum(['pending', 'completed']), 'must be pending or completed').optional(),
    MOCK_CONTROL: toggle.default('disabled'),
    MOCK_CONTROL_HOST: value(
        z.union([z.ipv4(), z.ipv6(), HostnameSchema]),
        'must be an IP address or hostname',
    ).default('127.0.0.1'),
    MOCK_CONTROL_PORT: value(
        z
            .string()
            .regex(/^[1-9]\d{0,4}$/)
            .transform(Number)
            .pipe(z.int().max(65_535)),
        'must be a port from 1 to 65535',
    ).default(4480),
    PTBK_MODE: value(z.literal('tunnel'), 'only tunnel is supported by the mock engine').default('tunnel'),
    PTBK_DATA_DIR: filePath,
    PTBK_RELAYS: parsed(parseRelays).optional(),
    PTBK_DASHBOARD_URL: parsed(parseDashboardUrl).optional(),
    PTBK_LINK_CODE: value(LinkCodeSchema, 'must be a link code').optional(),
    MOCK_HEARTBEAT_INTERVAL_S: value(
        z
            .string()
            .regex(/^[1-9]\d{0,3}$/)
            .transform(Number)
            .pipe(z.int().max(3600)),
        'must be a whole number of seconds from 1 to 3600',
    ).default(DEFAULT_HEARTBEAT_INTERVAL_S),
    MOCK_STATS: value(z.enum(['os', 'scenario']), 'must be os or scenario').default('os'),
    PTBK_UI_RELEASE_URL: parsed(parseReleaseUrl).optional(),
    PTBK_UPDATE_POLICY: value(z.enum(['auto', 'manual', 'pinned']), 'must be auto, manual or pinned').default('auto'),
    PTBK_PINNED_VERSION: value(EngineVersionSchema, 'must be a SemVer version').optional(),
    MOCK_UI_TRUST_POLICY_FILE: filePath.optional(),
    MOCK_UI_TRUSTED_ROOT_FILE: filePath.optional(),
    MOCK_UI_CHECK_INTERVAL_S: value(
        z
            .string()
            .regex(/^[1-9]\d{0,5}$/)
            .transform(Number)
            .pipe(z.int().max(86_400)),
        'must be a whole number of seconds from 1 to 86400',
    ).default(DEFAULT_UI_CHECK_INTERVAL_S),
    MOCK_UI_FAKE_PROVENANCE: toggle.default('disabled'),
    PTBK_CONFORMANCE_TRUST_FILE: filePath.optional(),
    PTBK_ENGINE_DOMAIN: value(HostnameSchema, 'must be a hostname'),
    PTBK_ENGINE_VERSION: value(EngineVersionSchema, 'must be a SemVer version').default(DEFAULT_ENGINE_VERSION),
    MOCK_EXTRA_CA_FILE: filePath.optional(),
    MOCK_DEV_CA_CERT_FILE: filePath.optional(),
    MOCK_DEV_CA_KEY_FILE: filePath.optional(),
    MOCK_DEV_CA_DOMAINS: parsed(parseDomains).optional(),
    MOCK_CERT_SOURCE: value(z.enum(['dev-ca', 'acme']), 'must be dev-ca or acme').default('dev-ca'),
    PTBK_ACME_DIRECTORY_URL: parsed(parseAcmeDirectoryUrl).optional(),
    PTBK_ACME_EMAIL: value(z.email().max(254), 'must be an email address').optional(),
    LOG_LEVEL: value(z.enum(LOG_LEVELS), `must be one of ${LOG_LEVELS.join(', ')}`).default('info'),
    HTTPS_PROXY: parsed(parseProxy).optional(),
    NO_PROXY: parsed(parseNoProxy).optional(),
});

const identitySchema = z.object({
    PTBK_DATA_DIR: filePath,
    PTBK_ENGINE_DOMAIN: value(HostnameSchema, 'must be a hostname'),
});

const devCaSchema = identitySchema.extend({ MOCK_DEV_CA_DOMAINS: parsed(parseDomains).optional() });

type Env = Readonly<Record<string, string | undefined>>;

/** Upper- and lowercase forms of the same proxy variable; tools disagree on precedence, so they must agree. */
const PROXY_VARIABLES = [
    ['HTTPS_PROXY', 'https_proxy'],
    ['NO_PROXY', 'no_proxy'],
] as const;

function isSetting(name: string): boolean {
    return name.startsWith('PTBK_') || name.startsWith('MOCK_') || name === 'LOG_LEVEL' || name === 'NODE_ENV';
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
    if (
        result.success &&
        (result.data.MOCK_DEV_CA_CERT_FILE === undefined) !== (result.data.MOCK_DEV_CA_KEY_FILE === undefined)
    ) {
        problems.push('MOCK_DEV_CA_CERT_FILE: must be set together with MOCK_DEV_CA_KEY_FILE');
    }
    problems.push(...dashboardProblems(settings), ...uiProblems(settings), ...certificateSourceProblems(settings));
    if (result.success && result.data.NODE_ENV === 'production') {
        if (result.data.MOCK_CONTROL === 'enabled') problems.push('MOCK_CONTROL: must not be enabled in production');
        if (result.data.MOCK_DEV_LOGIN === 'enabled')
            problems.push('MOCK_DEV_LOGIN: must not be enabled in production');
        if (result.data.MOCK_UI_FAKE_PROVENANCE === 'enabled') {
            problems.push('MOCK_UI_FAKE_PROVENANCE: must not be enabled in production');
        }
        if (result.data.PTBK_CONFORMANCE_TRUST_FILE !== undefined) {
            problems.push('PTBK_CONFORMANCE_TRUST_FILE: must not be set in production');
        }
    }
    if (!result.success || problems.length > 0) throw new ConfigError(problems);
    const parsedEnv = result.data;
    const devCaFiles =
        parsedEnv.MOCK_DEV_CA_CERT_FILE === undefined || parsedEnv.MOCK_DEV_CA_KEY_FILE === undefined
            ? null
            : Object.freeze({ certFile: parsedEnv.MOCK_DEV_CA_CERT_FILE, keyFile: parsedEnv.MOCK_DEV_CA_KEY_FILE });
    const proxy =
        parsedEnv.HTTPS_PROXY === undefined
            ? null
            : Object.freeze({ ...parsedEnv.HTTPS_PROXY, noProxy: parsedEnv.NO_PROXY ?? Object.freeze([]) });
    return Object.freeze({
        mode: parsedEnv.PTBK_MODE,
        dataDir: parsedEnv.PTBK_DATA_DIR,
        relays: parsedEnv.PTBK_RELAYS ?? Object.freeze([]),
        engineDomain: parsedEnv.PTBK_ENGINE_DOMAIN,
        engineVersion: parsedEnv.PTBK_ENGINE_VERSION,
        proxy,
        extraCaFile: parsedEnv.MOCK_EXTRA_CA_FILE ?? null,
        devCaFiles,
        devCaDomains: parsedEnv.MOCK_DEV_CA_DOMAINS ?? Object.freeze([]),
        certificateSource:
            parsedEnv.MOCK_CERT_SOURCE === 'acme' && parsedEnv.PTBK_ACME_DIRECTORY_URL !== undefined
                ? Object.freeze({
                      kind: 'acme',
                      directoryUrl: parsedEnv.PTBK_ACME_DIRECTORY_URL,
                      email: parsedEnv.PTBK_ACME_EMAIL ?? null,
                  })
                : Object.freeze({ kind: 'dev-ca' }),
        logLevel: parsedEnv.LOG_LEVEL,
        seed: parsedEnv.MOCK_SEED,
        scenario: parsedEnv.MOCK_SCENARIO,
        seedEpoch: parsedEnv.MOCK_SEED_EPOCH,
        faults: parsedEnv.MOCK_FAULTS ?? NO_FAULTS,
        capabilities: parsedEnv.MOCK_CAPABILITIES ?? PROFILE_CAPABILITY_NAMES[parsedEnv.MOCK_PROFILE],
        simulation: Object.freeze({ mode: parsedEnv.MOCK_SIMULATION, speed: parsedEnv.MOCK_SIMULATION_SPEED }),
        devLogin: parsedEnv.MOCK_DEV_LOGIN === 'enabled',
        passkeys: parsedEnv.MOCK_PASSKEYS,
        onboarding: parsedEnv.MOCK_ONBOARDING ?? null,
        control:
            parsedEnv.MOCK_CONTROL === 'enabled'
                ? Object.freeze({ host: parsedEnv.MOCK_CONTROL_HOST, port: parsedEnv.MOCK_CONTROL_PORT })
                : null,
        dashboard:
            parsedEnv.PTBK_DASHBOARD_URL === undefined
                ? null
                : Object.freeze({
                      url: parsedEnv.PTBK_DASHBOARD_URL,
                      linkCode: parsedEnv.PTBK_LINK_CODE === undefined ? null : oneTimeSecret(parsedEnv.PTBK_LINK_CODE),
                      heartbeatIntervalS: parsedEnv.MOCK_HEARTBEAT_INTERVAL_S,
                  }),
        stats: parsedEnv.MOCK_STATS,
        ui: uiConfig(parsedEnv),
    });
}

function uiTrustConfig(env: z.output<typeof envSchema>): UiTrustConfig | null {
    if (env.PTBK_CONFORMANCE_TRUST_FILE !== undefined) {
        return Object.freeze({ kind: 'conformance', file: env.PTBK_CONFORMANCE_TRUST_FILE });
    }
    if (env.MOCK_UI_TRUST_POLICY_FILE === undefined) return null;
    return Object.freeze({
        kind: 'files',
        trustPolicyFile: env.MOCK_UI_TRUST_POLICY_FILE,
        trustedRootFile: env.MOCK_UI_TRUSTED_ROOT_FILE ?? null,
        fakeProvenance: env.MOCK_UI_FAKE_PROVENANCE === 'enabled',
    });
}

function uiConfig(env: z.output<typeof envSchema>): UiLoaderConfig | null {
    const trust = uiTrustConfig(env);
    if (env.PTBK_UI_RELEASE_URL === undefined || trust === null) return null;
    const updatePolicy: UpdatePolicy =
        env.PTBK_UPDATE_POLICY === 'pinned' && env.PTBK_PINNED_VERSION !== undefined
            ? Object.freeze({ kind: 'pinned', version: env.PTBK_PINNED_VERSION })
            : Object.freeze({ kind: env.PTBK_UPDATE_POLICY === 'manual' ? 'manual' : 'auto' });
    return Object.freeze({
        releaseUrl: env.PTBK_UI_RELEASE_URL,
        updatePolicy,
        trust,
        checkIntervalS: env.MOCK_UI_CHECK_INTERVAL_S,
    });
}

const UI_LOADER_SETTINGS = [
    'PTBK_UPDATE_POLICY',
    'PTBK_PINNED_VERSION',
    'MOCK_UI_TRUST_POLICY_FILE',
    'MOCK_UI_TRUSTED_ROOT_FILE',
    'MOCK_UI_CHECK_INTERVAL_S',
    'MOCK_UI_FAKE_PROVENANCE',
    'PTBK_CONFORMANCE_TRUST_FILE',
] as const;

/** The development trust switches; the conformance trust file replaces all three, so none may be beside it. */
const UI_TRUST_FILE_SETTINGS = [
    'MOCK_UI_TRUST_POLICY_FILE',
    'MOCK_UI_TRUSTED_ROOT_FILE',
    'MOCK_UI_FAKE_PROVENANCE',
] as const;

/** The loader's settings only mean something together; judged by presence, like the dashboard's. */
function uiProblems(settings: Readonly<Record<string, string>>): string[] {
    const problems: string[] = [];
    if (settings['PTBK_UI_RELEASE_URL'] === undefined) {
        for (const name of UI_LOADER_SETTINGS) {
            if (settings[name] !== undefined) problems.push(`${name}: needs PTBK_UI_RELEASE_URL`);
        }
        return problems;
    }
    if (settings['PTBK_CONFORMANCE_TRUST_FILE'] !== undefined) {
        for (const name of UI_TRUST_FILE_SETTINGS) {
            if (settings[name] !== undefined) problems.push(`${name}: cannot be set with PTBK_CONFORMANCE_TRUST_FILE`);
        }
    } else if (settings['MOCK_UI_TRUST_POLICY_FILE'] === undefined) {
        problems.push('MOCK_UI_TRUST_POLICY_FILE: is required with PTBK_UI_RELEASE_URL');
    }
    if (settings['MOCK_UI_FAKE_PROVENANCE'] === 'enabled' && settings['MOCK_UI_TRUSTED_ROOT_FILE'] !== undefined) {
        problems.push('MOCK_UI_TRUSTED_ROOT_FILE: has no effect with MOCK_UI_FAKE_PROVENANCE enabled');
    }
    const pinned = settings['PTBK_UPDATE_POLICY'] === 'pinned';
    if (pinned && settings['PTBK_PINNED_VERSION'] === undefined) {
        problems.push('PTBK_PINNED_VERSION: is required with PTBK_UPDATE_POLICY=pinned');
    }
    if (!pinned && settings['PTBK_PINNED_VERSION'] !== undefined) {
        problems.push('PTBK_PINNED_VERSION: needs PTBK_UPDATE_POLICY=pinned');
    }
    return problems;
}

const DEV_CA_SETTINGS = ['MOCK_DEV_CA_CERT_FILE', 'MOCK_DEV_CA_KEY_FILE', 'MOCK_DEV_CA_DOMAINS'] as const;
const ACME_SETTINGS = ['PTBK_ACME_DIRECTORY_URL', 'PTBK_ACME_EMAIL'] as const;

/** Each certificate source takes only its own settings, so a leftover never looks like it took effect. */
function certificateSourceProblems(settings: Readonly<Record<string, string>>): string[] {
    const acme = settings['MOCK_CERT_SOURCE'] === 'acme';
    const problems: string[] = [];
    for (const name of acme ? DEV_CA_SETTINGS : ACME_SETTINGS) {
        if (settings[name] !== undefined) {
            problems.push(`${name}: needs MOCK_CERT_SOURCE=${acme ? 'dev-ca' : 'acme'}`);
        }
    }
    if (acme && settings['PTBK_ACME_DIRECTORY_URL'] === undefined) {
        problems.push('PTBK_ACME_DIRECTORY_URL: is required with MOCK_CERT_SOURCE=acme');
    }
    return problems;
}

/** Which relays the engine dials depends on whether a dashboard hands it a list (M-06); judged by presence only. */
function dashboardProblems(settings: Readonly<Record<string, string>>): string[] {
    const problems: string[] = [];
    const linked = settings['PTBK_DASHBOARD_URL'] !== undefined;
    const relays = settings['PTBK_RELAYS'] !== undefined;
    if (!linked && !relays) problems.push('PTBK_RELAYS: is required without PTBK_DASHBOARD_URL');
    if (!linked && settings['PTBK_LINK_CODE'] !== undefined) {
        problems.push('PTBK_LINK_CODE: needs PTBK_DASHBOARD_URL');
    }
    return problems;
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

/** For the `dev-ca` CLI: like {@link parseIdentityConfig}, plus `MOCK_DEV_CA_DOMAINS`. */
export function parseDevCaConfig(env: Env): DevCaConfig {
    const result = devCaSchema.safeParse({
        PTBK_DATA_DIR: present(env, 'PTBK_DATA_DIR'),
        PTBK_ENGINE_DOMAIN: present(env, 'PTBK_ENGINE_DOMAIN'),
        MOCK_DEV_CA_DOMAINS: present(env, 'MOCK_DEV_CA_DOMAINS'),
    });
    if (!result.success) throw new ConfigError(result.error.issues.flatMap(toProblems));
    return Object.freeze({
        dataDir: result.data.PTBK_DATA_DIR,
        engineDomain: result.data.PTBK_ENGINE_DOMAIN,
        devCaDomains: result.data.MOCK_DEV_CA_DOMAINS ?? Object.freeze([]),
    });
}
