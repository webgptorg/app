import { z } from 'zod';

import { environmentSchema, type Environment } from '../shared/environment';

export type { Environment };

/**
 * The rules of `@ptbk/protocol`'s `Hostname` (task C-01): ASCII, lowercased, 1–253 characters, at least two labels of
 * `[a-z0-9-]` without leading or trailing hyphens, no trailing dot, no IP literal. D-03 replaces this with the protocol
 * schema once C-01 has landed; the values are the same.
 */
const hostnameSchema = z
    .string()
    .transform((value) => value.toLowerCase())
    .pipe(
        z
            .string()
            .max(253)
            .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/)
            .refine((value) => !/^[0-9.]+$/.test(value), 'IP literals are not hostnames'),
    );

const relaySchema = z.strictObject({
    relayId: hostnameSchema,
    region: z
        .string()
        .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
        .max(32),
});

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

const varsSchema = z
    .strictObject({
        ENVIRONMENT: environmentSchema,
        DASHBOARD_ORIGIN: originSchema,
        ENGINE_DOMAIN: hostnameSchema,
        RELAYS: z.array(relaySchema).min(1).max(16),
        ADAPTERS: adaptersSchema,
    })
    .superRefine((vars, ctx) => {
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
    });

export type AdapterSelection = z.infer<typeof adaptersSchema>;
export type RelayConfig = z.infer<typeof relaySchema>;

export interface DashboardConfig {
    readonly environment: Environment;
    readonly dashboardOrigin: string;
    readonly engineDomain: string;
    readonly relays: readonly Readonly<RelayConfig>[];
    readonly adapters: Readonly<AdapterSelection>;
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
        adapters: Object.freeze({ ...parsed.ADAPTERS }),
    });
}
