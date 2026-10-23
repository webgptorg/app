import { Hostname, MAX_RELAYS } from '@ptbk/protocol';
import { z } from 'zod';

import { fromBase64Url } from '../domain/auth/secrets';
import { createPlanCatalogue, planCatalogueSchema, type PlanCatalogue } from '../domain/billing/plan-catalogue';
import { LINK_CODE_TTL_MS } from '../domain/registration/issue-link-code';
import type { HeartbeatTiming } from '../domain/status/engine-status';
import { DEFAULT_THRESHOLDS, thresholdsSchema, type AlertThresholds } from '../domain/monitoring/alert-rules';
import { environmentSchema, type Environment } from '../shared/environment';

export type { Environment };

const relaySchema = z.strictObject({
    relayId: Hostname,
    region: z
        .string()
        .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
        .max(32),
});

export const LINK_CODE_PLACEHOLDER = '{linkCode}';

/**
 * What `/engines/new` shows, with {@link LINK_CODE_PLACEHOLDER} exactly once. In dev it starts X-06's local mock engine;
 * the real command comes from the engine team (E-01).
 */
const installCommandSchema = z
    .string()
    .max(512)
    .refine((value) => value.split(LINK_CODE_PLACEHOLDER).length === 2, `must contain ${LINK_CODE_PLACEHOLDER} once`);

const adaptersSchema = z.strictObject({
    email: z.enum(['cloudflare', 'fake']),
    billing: z.enum(['stripe', 'fake']),
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
 * How long a link code can be redeemed, in seconds; 30 minutes by default (D-03). Never longer, so the countdown on
 * `/engines/new` and the spec's promise hold; the e2e stack shortens it to test expiry without a clock hook.
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

/** At least 256 bits, base64url without padding. */
const hmacKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43,86}$/);

/** Secret and restricted API keys; `wrangler secret put STRIPE_SECRET_KEY`, never a var. */
const stripeKeySchema = z.string().regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,255}$/);
const stripeWebhookSecretSchema = z.string().regex(/^whsec_[A-Za-z0-9+/=]{16,255}$/);

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
        INSTALL_COMMAND: installCommandSchema,
        ADAPTERS: adaptersSchema,
        EMAIL_FROM: z.email().max(254),
        RATE_LIMIT_HMAC_KEY: hmacKeySchema,
        BILLING_PLANS: planCatalogueSchema,
        HEARTBEAT: heartbeatSchema.optional(),
        LINK_CODE_TTL_S: linkCodeTtlSchema.optional(),
        STRIPE_SECRET_KEY: stripeKeySchema.optional(),
        STRIPE_WEBHOOK_SECRET: stripeWebhookSecretSchema.optional(),
        MONITORING: monitoringSchema.optional(),
        RELAY_METRICS_TOKENS: relayMetricsTokensSchema.optional(),
        ANALYTICS: analyticsSchema.optional(),
        ANALYTICS_API_TOKEN: analyticsTokenSchema.optional(),
    })
    .superRefine((vars, ctx) => {
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
    });

export type AdapterSelection = z.infer<typeof adaptersSchema>;
export type RelayConfig = z.infer<typeof relaySchema>;

export interface DashboardConfig {
    readonly environment: Environment;
    readonly dashboardOrigin: string;
    readonly engineDomain: Hostname;
    readonly relays: readonly Readonly<RelayConfig>[];
    /** Contains {@link LINK_CODE_PLACEHOLDER} exactly once. */
    readonly installCommand: string;
    readonly adapters: Readonly<AdapterSelection>;
    /** The sender address for the `send_email` binding. */
    readonly emailFrom: string;
    /** Secret: keys rate-limit counters, so raw IPs and emails are never stored. */
    readonly rateLimitHmacKey: Uint8Array;
    readonly plans: PlanCatalogue;
    readonly heartbeat: HeartbeatTiming;
    readonly linkCodeTtlMs: number;
    /** Secret; present whenever `adapters.billing` is `stripe`. */
    readonly stripeSecretKey: string | null;
    /** Secret; present whenever `adapters.billing` is `stripe`, optional with the fake. */
    readonly stripeWebhookSecret: string | null;
    /** I-04; null where `MONITORING` is not set: no relay is scraped and no alert is sent. */
    readonly monitoring: MonitoringConfig | null;
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
        installCommand: parsed.INSTALL_COMMAND,
        adapters: Object.freeze({ ...parsed.ADAPTERS }),
        emailFrom: parsed.EMAIL_FROM,
        rateLimitHmacKey: fromBase64Url(parsed.RATE_LIMIT_HMAC_KEY),
        plans: createPlanCatalogue(parsed.BILLING_PLANS),
        heartbeat: Object.freeze({ ...(parsed.HEARTBEAT ?? heartbeatSchema.parse({})) }),
        linkCodeTtlMs: parsed.LINK_CODE_TTL_S === undefined ? LINK_CODE_TTL_MS : parsed.LINK_CODE_TTL_S * 1000,
        stripeSecretKey: parsed.STRIPE_SECRET_KEY ?? null,
        stripeWebhookSecret: parsed.STRIPE_WEBHOOK_SECRET ?? null,
        monitoring: monitoringConfig(parsed),
    });
}
