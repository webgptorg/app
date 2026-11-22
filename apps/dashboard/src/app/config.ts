import { Hostname, MAX_RELAYS } from '@ptbk/protocol';
import { z } from 'zod';

import { fromBase64Url } from '../domain/auth/secrets';
import {
    createPlanCatalogue,
    createPlanEntitlements,
    planCatalogueSchema,
    planEntitlementsSchema,
    type PlanCatalogue,
    type PlanEntitlements,
} from '../domain/billing/plan-catalogue';
import { CT_SOURCES, type CtSourceName } from '../domain/abuse/ct-log-source';
import { MOCK_ENGINE_SIGN_IN_FINGERPRINT } from '../domain/abuse/public-face';
import { LINK_CODE_TTL_MS } from '../domain/registration/issue-link-code';
import type { HeartbeatTiming } from '../domain/status/engine-status';
import { DEFAULT_THRESHOLDS, thresholdsSchema, type AlertThresholds } from '../domain/monitoring/alert-rules';
import { environmentSchema, type Environment } from '../shared/environment';
import { engineInstallReleaseSchema, type EngineInstallRelease } from '../shared/engine-installation';
import {
    docsAnchorSchema,
    installPathIdSchema,
    installPathLabelKeySchema,
    type InstallPathId,
    type InstallPathLabelKey,
} from '../shared/install-paths';

export type { Environment };

const relaySchema = z.strictObject({
    relayId: Hostname,
    region: z
        .string()
        .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
        .max(32),
});

export const LINK_CODE_PLACEHOLDER = '{linkCode}';
/** The link URL, `<DASHBOARD_ORIGIN>/link#<code>`: the engine learns the dashboard from it and needs no setting. */
export const LINK_URL_PLACEHOLDER = '{linkUrl}';

function occurrences(value: string, placeholder: string): number {
    return value.split(placeholder).length - 1;
}

/**
 * A command `/engines/new` shows, with exactly one placeholder, {@link LINK_CODE_PLACEHOLDER} or
 * {@link LINK_URL_PLACEHOLDER}, once; it may span lines. In dev they run X-06's local mock engine; the real ones come
 * from the engine team.
 */
const installCommandSchema = z
    .string()
    .max(512)
    .refine(
        (value) => occurrences(value, LINK_CODE_PLACEHOLDER) + occurrences(value, LINK_URL_PLACEHOLDER) === 1,
        `must contain ${LINK_CODE_PLACEHOLDER} or ${LINK_URL_PLACEHOLDER} once`,
    );

/** The tabs of `/engines/new`, in order, each path at most once. */
const installCommandsSchema = z
    .array(
        z.strictObject({
            id: installPathIdSchema,
            labelKey: installPathLabelKeySchema,
            template: installCommandSchema,
            docsAnchor: docsAnchorSchema,
        }),
    )
    .min(1)
    .refine((paths) => new Set(paths.map((path) => path.id)).size === paths.length, 'duplicate id');

/** D-03's single `INSTALL_COMMAND`, still read for one release, becomes the installer tab. */
const LEGACY_INSTALL_PATH: Omit<InstallCommandConfig, 'template'> = {
    id: 'installer',
    labelKey: 'docker-server',
    docsAnchor: '1-the-installer-recommended',
};

/** Anchors are appended to it, so it carries none of its own. */
const installGuideUrlSchema = z
    .url({ protocol: /^https$/ })
    .max(384)
    .refine((value) => !value.includes('#'), 'must not have a fragment');

const adaptersSchema = z.strictObject({
    email: z.enum(['cloudflare', 'fake']),
    /** `off` (dev and staging): nobody is charged and every organization holds `BILLING_OFF_PLAN`; no Stripe at all. */
    billing: z.enum(['stripe', 'fake', 'off', 'website']),
    rateLimit: z.enum(['workers', 'memory']),
});

const originSchema = z.url({ protocol: /^https?$/ }).transform((value, ctx) => {
    const url = new URL(value);
    if (url.origin !== value.replace(/\/$/, '')) {
        ctx.addIssue({ code: 'custom', message: 'must be a bare origin without path, query or fragment' });
        return z.NEVER;
    }
    return url.origin;
});

/**
 * When an engine counts as offline (D-05): `missedLimit` heartbeats of `intervalS` plus `graceS`. Engines send every
 * 60 s by default (E-01); the e2e stack sends every 15 s. `perEngineLimit` caps heartbeats per engine and minute.
 */
const heartbeatSchema = z
    .strictObject({
        intervalS: z.int().min(5).max(3600).default(60),
        missedLimit: z.int().min(1).max(10).default(3),
        graceS: z.int().min(0).max(600).default(15),
        perEngineLimit: z.int().min(1).max(60).default(5),
    })
    .refine(
        (heartbeat) => heartbeat.perEngineLimit * heartbeat.intervalS >= 60,
        'perEngineLimit must let an engine send every intervalS',
    );

/**
 * How long a link code can be redeemed, in seconds; 30 days by default. Never longer, so the expiry the dashboard shows
 * and the spec's promise hold; the e2e stack shortens it to test expiry without a clock hook.
 */
const linkCodeTtlSchema = z
    .int()
    .min(10)
    .max(LINK_CODE_TTL_MS / 1000);

/**
 * The dev-only HMAC key for rate-limit keys, committed in wrangler.jsonc's top-level vars. Every other environment gets
 * its own from `wrangler secret put RATE_LIMIT_HMAC_KEY`; this value is refused there.
 */
export const DEV_RATE_LIMIT_HMAC_KEY = 'ZGV2LW9ubHktcmF0ZS1saW1pdC1rZXktbm90LXNlY3JldA';

/**
 * The dev-only member key seed (ADR 0018), committed in wrangler.jsonc's top-level vars so the local stack signs access
 * tickets. Every other environment gets its own from `wrangler secret put MEMBER_KEY`; this value is refused there.
 */
export const DEV_MEMBER_KEY = 'ZGV2LW9ubHktbWVtYmVyLWtleS1ub3QtYS1zZWNyZXQ';

/** An Ed25519 seed: 32 bytes, base64url without padding. */
const memberKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** At least 256 bits, base64url without padding. */
const hmacKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43,86}$/);

/** Secret and restricted API keys; `wrangler secret put STRIPE_SECRET_KEY`, never a var. */
const stripeKeySchema = z.string().regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,255}$/);
const stripeWebhookSecretSchema = z.string().regex(/^whsec_[A-Za-z0-9+/=]{16,255}$/);

/** Production's website, where licences are sold (ADR 0021); staging may point `WEBSITE_ORIGIN` at another one. */
export const DEFAULT_WEBSITE_ORIGIN = 'https://www.ptbk.io';

/** The website is reached server to server with a bearer secret, so plain http is refused even in dev. */
const websiteOriginSchema = originSchema.refine((origin) => origin.startsWith('https://'), 'must be https');

/**
 * The website's App credential (ADR 0021), shared with the website only; `wrangler secret put
 * PROMPTBOOK_APP_LICENSE_SECRET`, never a var, never sent to the SPA. The website trims its copy and wants at least 32
 * characters; here it must be exactly what it compares against, so no whitespace at all.
 */
const licenseSecretSchema = z.string().regex(/^[\x21-\x7e]{32,512}$/);

/**
 * Vars and secrets are JSON values. Anything else (D1, ASSETS, service bindings the runtime or the test pool adds) is a
 * runtime object that the composition root wires up; config never reads it. Every JSON value must be a known var.
 */
function isVar(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return typeof value !== 'function';
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/** Per relay (I-04): `GET /metrics` on the relay's hostname answers only its token. Secret: `RELAY_METRICS_TOKENS`. */
const METRICS_TOKEN = /^ptbk_mt_[A-Za-z0-9_-]{43}$/;

/** A JSON object from relay ID to metrics token, as one secret, since a secret is a single string. */
const relayMetricsTokensSchema = z
    .string()
    .max(64 * 1024)
    .transform((value, ctx) => {
        try {
            return JSON.parse(value) as unknown;
        } catch {
            ctx.addIssue({ code: 'custom', message: 'must be a JSON object' });
            return z.NEVER;
        }
    })
    .pipe(z.record(Hostname, z.string().regex(METRICS_TOKEN)));

/** I-04's monitoring job; without it no relay is scraped and alerts are not sent. */
const monitoringSchema = z.strictObject({
    opsEmail: z.email().max(254),
    thresholds: thresholdsSchema.optional(),
    /** Per relay, for its health check and scrape together. */
    probeTimeoutMs: z.int().min(1000).max(30_000).default(10_000),
});

/** Analytics Engine's SQL API, where the alert rules read the dashboard's own counters back. */
const analyticsSchema = z.strictObject({
    accountId: z.string().regex(/^[0-9a-f]{32}$/),
    dataset: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
});
const analyticsTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{40,128}$/);

/**
 * I-05's abuse jobs, which run with `MONITORING` (they alert through it). Every field is optional; the defaults are
 * {@link DEFAULT_ABUSE_MONITORING}.
 */
const abuseMonitoringSchema = z.strictObject({
    ctSources: z.array(z.enum(CT_SOURCES)).min(1).max(CT_SOURCES.length).optional(),
    /** `O=` values of the expected issuers. */
    allowedIssuers: z.array(z.string().min(1).max(128)).min(1).max(10).optional(),
    issuanceSpike: z.strictObject({ limit: z.int().min(1).max(1000), days: z.int().min(1).max(90) }).optional(),
    publicFace: z
        .strictObject({
            fingerprints: z
                .array(z.string().regex(/^[0-9a-f]{64}$/))
                .min(1)
                .max(20)
                .optional(),
            perRun: z.int().min(1).max(200).optional(),
        })
        .optional(),
});

/** Cert Spotter answers without a key, within an hourly allowance; a key lifts it. */
const certSpotterKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);

/** A Google Cloud API key, restricted to the Web Risk API (docs/plan/apply.md). */
const webRiskKeySchema = z.string().regex(/^AIza[A-Za-z0-9_-]{35}$/);

export interface AbuseMonitoringConfig {
    readonly ctSources: readonly CtSourceName[];
    readonly allowedIssuers: readonly string[];
    readonly issuanceSpike: { readonly limit: number; readonly days: number };
    readonly publicFace: { readonly fingerprints: readonly string[]; readonly perRun: number };
    /** Secret, optional. */
    readonly certSpotterApiKey: string | null;
    /** Secret; without it the `abuse-feeds` job is not registered (I-08). */
    readonly webRiskApiKey: string | null;
}

/**
 * The defaults, until production says otherwise: engines get Let's Encrypt certificates only (M-03), so any other
 * issuer is unexpected; Let's Encrypt allows 5 duplicate certificates per week, so a fourth within 7 days means an
 * engine is burning through it (a renewal loop or key churn); the public-face check knows only the mock engine's
 * sign-in page until the engine team publishes a marker, and 30 engines per 15-minute run cover 2,880 a day.
 */
export const DEFAULT_ABUSE_MONITORING: Omit<AbuseMonitoringConfig, 'certSpotterApiKey' | 'webRiskApiKey'> = {
    ctSources: CT_SOURCES,
    allowedIssuers: ["Let's Encrypt"],
    issuanceSpike: { limit: 3, days: 7 },
    publicFace: { fingerprints: [MOCK_ENGINE_SIGN_IN_FINGERPRINT], perRun: 30 },
};

/** The label a relay has in metrics and alerts: its hostname's first label, which must be unique among the relays. */
export function relayName(relayId: string): string {
    return relayId.replace(/\..*$/, '');
}

const varsSchema = z
    .strictObject({
        ENVIRONMENT: environmentSchema,
        DASHBOARD_ORIGIN: originSchema,
        ENGINE_DOMAIN: Hostname,
        RELAYS: z
            .array(relaySchema)
            .min(1)
            .max(MAX_RELAYS)
            .refine(
                (relays) => new Set(relays.map((relay) => relay.relayId)).size === relays.length,
                'duplicate relayId',
            ),
        INSTALL_COMMANDS: installCommandsSchema.optional(),
        /** Reviewed published artifacts for engine-first command, AI and Windows installation. */
        ENGINE_INSTALLATION: engineInstallReleaseSchema.optional(),
        /** D-03's single command; read only without `INSTALL_COMMANDS`, for one release. */
        INSTALL_COMMAND: installCommandSchema.optional(),
        INSTALL_GUIDE_URL: installGuideUrlSchema,
        ADAPTERS: adaptersSchema,
        EMAIL_FROM: z.email().max(254),
        ABUSE_EMAIL: z.email().max(254),
        RATE_LIMIT_HMAC_KEY: hmacKeySchema,
        MEMBER_KEY: memberKeySchema.optional(),
        /** Required unless billing is `off`; with `off` it may be staged, validated and unused, for switching on. */
        BILLING_PLANS: planCatalogueSchema.optional(),
        /** What every organization holds with billing `off`, and only then. */
        BILLING_OFF_PLAN: planEntitlementsSchema.optional(),
        HEARTBEAT: heartbeatSchema.optional(),
        LINK_CODE_TTL_S: linkCodeTtlSchema.optional(),
        STRIPE_SECRET_KEY: stripeKeySchema.optional(),
        STRIPE_WEBHOOK_SECRET: stripeWebhookSecretSchema.optional(),
        MONITORING: monitoringSchema.optional(),
        RELAY_METRICS_TOKENS: relayMetricsTokensSchema.optional(),
        ANALYTICS: analyticsSchema.optional(),
        ANALYTICS_API_TOKEN: analyticsTokenSchema.optional(),
        ABUSE_MONITORING: abuseMonitoringSchema.optional(),
        CERTSPOTTER_API_KEY: certSpotterKeySchema.optional(),
        WEB_RISK_API_KEY: webRiskKeySchema.optional(),
        WEBSITE_ORIGIN: websiteOriginSchema.optional(),
        PROMPTBOOK_APP_LICENSE_SECRET: licenseSecretSchema.optional(),
    })
    .superRefine((vars, ctx) => {
        if (
            vars.INSTALL_COMMANDS === undefined &&
            vars.INSTALL_COMMAND === undefined &&
            vars.ENGINE_INSTALLATION === undefined
        ) {
            ctx.addIssue({ code: 'custom', path: ['INSTALL_COMMANDS'], message: 'required' });
        }
        if (vars.INSTALL_COMMANDS !== undefined && vars.INSTALL_COMMAND !== undefined) {
            ctx.addIssue({ code: 'custom', path: ['INSTALL_COMMAND'], message: 'replaced by INSTALL_COMMANDS' });
        }
        // Engines accept only https:// link URLs, so a plain-http dev origin can hand out codes only.
        const templates = [...(vars.INSTALL_COMMANDS ?? []).map((path) => path.template), vars.INSTALL_COMMAND ?? ''];
        const usesLinkUrl =
            vars.ENGINE_INSTALLATION !== undefined ||
            templates.some((template) => template.includes(LINK_URL_PLACEHOLDER));
        if (usesLinkUrl && !vars.DASHBOARD_ORIGIN.startsWith('https://')) {
            ctx.addIssue({
                code: 'custom',
                path: ['INSTALL_COMMANDS'],
                message: `${LINK_URL_PLACEHOLDER} needs an https DASHBOARD_ORIGIN`,
            });
        }
        if (vars.ADAPTERS.billing === 'off') {
            if (vars.BILLING_OFF_PLAN === undefined) {
                ctx.addIssue({ code: 'custom', path: ['BILLING_OFF_PLAN'], message: 'required with billing off' });
            }
            // Production charges (Seb, 2026-11-04): only dev and staging may give engines away.
            if (vars.ENVIRONMENT === 'production') {
                ctx.addIssue({
                    code: 'custom',
                    path: ['ADAPTERS', 'billing'],
                    message: 'billing off is not for production',
                });
            }
        } else if (vars.ADAPTERS.billing !== 'website') {
            if (vars.BILLING_PLANS === undefined) {
                ctx.addIssue({ code: 'custom', path: ['BILLING_PLANS'], message: 'required with billing on' });
            }
            // Once billing is on, a leftover grant would look like it still applies.
            if (vars.BILLING_OFF_PLAN !== undefined) {
                ctx.addIssue({ code: 'custom', path: ['BILLING_OFF_PLAN'], message: 'only with billing off' });
            }
        }
        if (vars.ADAPTERS.billing === 'website' && vars.PROMPTBOOK_APP_LICENSE_SECRET === undefined) {
            ctx.addIssue({
                code: 'custom',
                path: ['PROMPTBOOK_APP_LICENSE_SECRET'],
                message: 'required by the website billing adapter',
            });
        }
        if (vars.ADAPTERS.billing === 'stripe') {
            for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] as const) {
                if (vars[name] === undefined) {
                    ctx.addIssue({ code: 'custom', path: [name], message: 'required by the stripe billing adapter' });
                }
            }
        }
        if (vars.ENVIRONMENT !== 'production' && vars.STRIPE_SECRET_KEY?.includes('_live_') === true) {
            ctx.addIssue({ code: 'custom', path: ['STRIPE_SECRET_KEY'], message: 'live keys run only in production' });
        }
        if (vars.MONITORING !== undefined) {
            const tokens = vars.RELAY_METRICS_TOKENS ?? {};
            const relayIds = vars.RELAYS.map((relay) => relay.relayId as string);
            if (relayIds.some((id) => !Object.hasOwn(tokens, id)) || Object.keys(tokens).length !== relayIds.length) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['RELAY_METRICS_TOKENS'],
                    message: 'needs exactly one token per relay with MONITORING',
                });
            }
            if (new Set(relayIds.map(relayName)).size !== relayIds.length) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['RELAYS'],
                    message: 'relay names (first labels) must be unique',
                });
            }
            if (vars.ENVIRONMENT !== 'dev') {
                for (const name of ['ANALYTICS', 'ANALYTICS_API_TOKEN'] as const) {
                    if (vars[name] === undefined) {
                        ctx.addIssue({ code: 'custom', path: [name], message: 'required by MONITORING outside dev' });
                    }
                }
            }
        }
        if (vars.ENVIRONMENT === 'dev') {
            return;
        }
        for (const [port, adapter] of Object.entries(vars.ADAPTERS)) {
            if (adapter === 'fake' || adapter === 'memory') {
                ctx.addIssue({
                    code: 'custom',
                    path: ['ADAPTERS', port],
                    message: `${adapter} adapters run only in dev`,
                });
            }
        }
        if (!vars.DASHBOARD_ORIGIN.startsWith('https://')) {
            ctx.addIssue({ code: 'custom', path: ['DASHBOARD_ORIGIN'], message: 'must be https outside dev' });
        }
        if (vars.RATE_LIMIT_HMAC_KEY === DEV_RATE_LIMIT_HMAC_KEY) {
            ctx.addIssue({ code: 'custom', path: ['RATE_LIMIT_HMAC_KEY'], message: 'the dev key runs only in dev' });
        }
        if (vars.MEMBER_KEY === DEV_MEMBER_KEY) {
            ctx.addIssue({ code: 'custom', path: ['MEMBER_KEY'], message: 'the dev key runs only in dev' });
        }
    });

export type AdapterSelection = z.infer<typeof adaptersSchema>;

/**
 * `adapters.billing` with what it needs: `off` grants one fixed plan and has no catalogue; otherwise the catalogue's
 * plans are sold through the provider.
 */
export type BillingConfig =
    | {
          readonly adapter: 'website';
          readonly websiteOrigin: string;
          /** Secret: the website's App credential; server to server only. */
          readonly licenseSecret: string;
      }
    | { readonly adapter: 'off'; readonly grant: PlanEntitlements }
    | { readonly adapter: 'stripe' | 'fake'; readonly plans: PlanCatalogue };

export interface InstallCommandConfig {
    readonly id: InstallPathId;
    readonly labelKey: InstallPathLabelKey;
    readonly template: string;
    readonly docsAnchor: string;
}
export type RelayConfig = z.infer<typeof relaySchema>;

export interface DashboardConfig {
    readonly environment: Environment;
    readonly dashboardOrigin: string;
    readonly engineDomain: Hostname;
    readonly relays: readonly Readonly<RelayConfig>[];
    /** The tabs of `/engines/new`, in order; each template contains one placeholder exactly once. */
    readonly installCommands: readonly InstallCommandConfig[];
    readonly engineInstallation?: Readonly<EngineInstallRelease>;
    /** The public install guide, without a fragment. */
    readonly installGuideUrl: string;
    readonly adapters: Readonly<AdapterSelection>;
    /** The sender address for the `send_email` binding. */
    readonly emailFrom: string;
    /**
     * The public abuse contact (I-05): on `/abuse`, in `security.txt`, on a suspended engine's page; abuse alerts go
     * there too.
     */
    readonly abuseEmail: string;
    /** Secret: keys rate-limit counters, so raw IPs and emails are never stored. */
    readonly rateLimitHmacKey: Uint8Array;
    /** The member key's Ed25519 seed (ADR 0018); null leaves tickets unavailable and revocations queued. */
    readonly memberKeySeed: Uint8Array<ArrayBuffer> | null;
    readonly billing: BillingConfig;
    readonly heartbeat: HeartbeatTiming;
    readonly linkCodeTtlMs: number;
    /** Secret; present whenever `adapters.billing` is `stripe`; may be put ahead of switching from `off`, unused. */
    readonly stripeSecretKey: string | null;
    /** Secret; present whenever `adapters.billing` is `stripe`, optional with the fake. */
    readonly stripeWebhookSecret: string | null;
    /** I-04; null where `MONITORING` is not set: no relay is scraped and no alert is sent. */
    readonly monitoring: MonitoringConfig | null;
    /** I-05's abuse jobs; they run only with `monitoring`. */
    readonly abuseMonitoring: AbuseMonitoringConfig;
}

export interface MonitoringConfig {
    readonly opsEmail: string;
    readonly thresholds: AlertThresholds;
    readonly probeTimeoutMs: number;
    /** Every configured relay, with its metrics token (secret). */
    readonly relays: readonly {
        readonly relayId: Hostname;
        readonly name: string;
        readonly metricsToken: string;
    }[];
    /** Required outside dev; in dev the counters stay in memory and this is not used. */
    readonly analytics: { readonly accountId: string; readonly dataset: string; readonly token: string } | null;
}

export class ConfigError extends Error {
    /** Paths of the offending vars only: values may be secrets. */
    readonly paths: readonly string[];

    constructor(paths: readonly string[]) {
        super(`Invalid dashboard configuration: ${paths.join(', ')}`);
        this.name = 'ConfigError';
        this.paths = paths;
    }
}

function monitoringConfig(parsed: z.infer<typeof varsSchema>): MonitoringConfig | null {
    const { MONITORING: monitoring, RELAY_METRICS_TOKENS: tokens = {}, ANALYTICS: analytics } = parsed;
    const token = parsed.ANALYTICS_API_TOKEN;
    if (monitoring === undefined) {
        return null;
    }
    return Object.freeze({
        opsEmail: monitoring.opsEmail,
        thresholds: monitoring.thresholds ?? DEFAULT_THRESHOLDS,
        probeTimeoutMs: monitoring.probeTimeoutMs,
        relays: Object.freeze(
            parsed.RELAYS.map((relay) =>
                Object.freeze({
                    relayId: relay.relayId,
                    name: relayName(relay.relayId),
                    metricsToken: tokens[relay.relayId] as string,
                }),
            ),
        ),
        analytics: analytics === undefined || token === undefined ? null : Object.freeze({ ...analytics, token }),
    });
}

function abuseMonitoringConfig(parsed: z.infer<typeof varsSchema>): AbuseMonitoringConfig {
    const vars = parsed.ABUSE_MONITORING ?? {};
    const defaults = DEFAULT_ABUSE_MONITORING;
    return Object.freeze({
        ctSources: Object.freeze([...new Set(vars.ctSources ?? defaults.ctSources)]),
        allowedIssuers: Object.freeze([...(vars.allowedIssuers ?? defaults.allowedIssuers)]),
        issuanceSpike: Object.freeze({ ...(vars.issuanceSpike ?? defaults.issuanceSpike) }),
        publicFace: Object.freeze({
            fingerprints: Object.freeze([...(vars.publicFace?.fingerprints ?? defaults.publicFace.fingerprints)]),
            perRun: vars.publicFace?.perRun ?? defaults.publicFace.perRun,
        }),
        certSpotterApiKey: parsed.CERTSPOTTER_API_KEY ?? null,
        webRiskApiKey: parsed.WEB_RISK_API_KEY ?? null,
    });
}

function billingConfig(parsed: z.infer<typeof varsSchema>): BillingConfig {
    const adapter = parsed.ADAPTERS.billing;
    // The refinement above requires the var each adapter reads.
    if (adapter === 'website') {
        return Object.freeze({
            adapter,
            websiteOrigin: parsed.WEBSITE_ORIGIN ?? DEFAULT_WEBSITE_ORIGIN,
            licenseSecret: parsed.PROMPTBOOK_APP_LICENSE_SECRET as string,
        });
    }
    return adapter === 'off'
        ? Object.freeze({ adapter, grant: createPlanEntitlements(parsed.BILLING_OFF_PLAN as PlanEntitlementsVar) })
        : Object.freeze({ adapter, plans: createPlanCatalogue(parsed.BILLING_PLANS as PlanCatalogueVar) });
}

type PlanEntitlementsVar = z.output<typeof planEntitlementsSchema>;
type PlanCatalogueVar = z.output<typeof planCatalogueSchema>;

function installCommandsConfig(parsed: z.infer<typeof varsSchema>): readonly InstallCommandConfig[] {
    const legacy =
        parsed.INSTALL_COMMAND === undefined ? [] : [{ ...LEGACY_INSTALL_PATH, template: parsed.INSTALL_COMMAND }];
    return Object.freeze((parsed.INSTALL_COMMANDS ?? legacy).map((path) => Object.freeze({ ...path })));
}

/** Parses Workers bindings once, in the composition root; nothing else reads `env`. Throws {@link ConfigError}. */
export function parseConfig(env: object): DashboardConfig {
    const entries: readonly [string, unknown][] = Object.entries(env);
    const vars = Object.fromEntries(entries.filter(([, value]) => isVar(value)));
    const result = varsSchema.safeParse(vars);
    if (!result.success) {
        throw new ConfigError(
            result.error.issues.flatMap((issue) =>
                issue.code === 'unrecognized_keys'
                    ? issue.keys.map((key) => [...issue.path, key].join('.'))
                    : [issue.path.join('.')],
            ),
        );
    }
    const parsed = result.data;
    return Object.freeze({
        environment: parsed.ENVIRONMENT,
        dashboardOrigin: parsed.DASHBOARD_ORIGIN,
        engineDomain: parsed.ENGINE_DOMAIN,
        relays: Object.freeze(parsed.RELAYS.map((relay) => Object.freeze({ ...relay }))),
        installCommands: installCommandsConfig(parsed),
        ...(parsed.ENGINE_INSTALLATION === undefined
            ? {}
            : { engineInstallation: Object.freeze({ ...parsed.ENGINE_INSTALLATION }) }),
        installGuideUrl: parsed.INSTALL_GUIDE_URL,
        adapters: Object.freeze({ ...parsed.ADAPTERS }),
        emailFrom: parsed.EMAIL_FROM,
        abuseEmail: parsed.ABUSE_EMAIL,
        rateLimitHmacKey: fromBase64Url(parsed.RATE_LIMIT_HMAC_KEY),
        memberKeySeed: parsed.MEMBER_KEY === undefined ? null : fromBase64Url(parsed.MEMBER_KEY),
        billing: billingConfig(parsed),
        heartbeat: Object.freeze({ ...(parsed.HEARTBEAT ?? heartbeatSchema.parse({})) }),
        linkCodeTtlMs: parsed.LINK_CODE_TTL_S === undefined ? LINK_CODE_TTL_MS : parsed.LINK_CODE_TTL_S * 1000,
        stripeSecretKey: parsed.STRIPE_SECRET_KEY ?? null,
        stripeWebhookSecret: parsed.STRIPE_WEBHOOK_SECRET ?? null,
        monitoring: monitoringConfig(parsed),
        abuseMonitoring: abuseMonitoringConfig(parsed),
    });
}
