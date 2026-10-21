import { z } from 'zod';

const MAX_LATENCY_MS = 60_000;
const MAX_ROUTE_GLOBS = 32;
const MAX_ROUTE_GLOB_LENGTH = 256;
const MIN_TUNNEL_BYTES_PER_S = 64;
const MAX_TUNNEL_BYTES_PER_S = 1_000_000_000;
const MAX_PLAN_JSON_LENGTH = 16 * 1024;

const rate = z.number().min(0).max(1);

/**
 * Switchable faults (ADR 0004), from `MOCK_FAULTS` at startup or `PUT /__mock/faults` at runtime. Every field has a
 * harmless default, so `{}` means no faults.
 */
export const FaultPlan = z.strictObject({
    latencyMs: z
        .strictObject({
            min: z.int().min(0).max(MAX_LATENCY_MS),
            max: z.int().min(0).max(MAX_LATENCY_MS),
        })
        .refine(({ min, max }) => min <= max, { message: 'min must not exceed max', path: ['max'] })
        .default({ min: 0, max: 0 }),
    errorRate: rate.default(0),
    errorStatus: z.union([z.literal(500), z.literal(502), z.literal(503)]).default(503),
    /** Probability that an SSE response is cut mid-stream. */
    dropStreamRate: rate.default(0),
    /** Pace of bytes from the engine into the tunnel; `null` is unthrottled. */
    slowTunnelBytesPerS: z.int().min(MIN_TUNNEL_BYTES_PER_S).max(MAX_TUNNEL_BYTES_PER_S).nullable().default(null),
    /** Share of simulated runs that fail; `null` keeps the simulation's own believable rate. */
    runFailureRate: rate.nullable().default(null),
    /** Simulated runs stay `queued`, so the queue's `oldestQueuedAt` keeps getting older. */
    stuckQueue: z.boolean().default(false),
    /** Share of new files (uploads and run outputs) the scanner finds infected. */
    scanInfectedRate: rate.default(0),
    /** Share of connection tests (create, check, enable) that end in `error`. */
    integrationErrorRate: rate.default(0),
    /** Request-path globs the faults apply to: `*` within one segment, `**` across segments. Absent means every path. */
    routes: z
        .array(z.string().min(1).max(MAX_ROUTE_GLOB_LENGTH).startsWith('/'))
        .min(1)
        .max(MAX_ROUTE_GLOBS)
        .optional(),
});
export type FaultPlan = z.output<typeof FaultPlan>;

export const NO_FAULTS: FaultPlan = Object.freeze(FaultPlan.parse({}));

export type FaultPlanParse =
    | { readonly kind: 'ok'; readonly plan: FaultPlan }
    | { readonly kind: 'invalid'; readonly problems: readonly string[] };

/** For `MOCK_FAULTS`. Problems name the field and what is wrong, never the value. */
export function parseFaultPlanJson(text: string): FaultPlanParse {
    if (text.length > MAX_PLAN_JSON_LENGTH) return { kind: 'invalid', problems: ['is too long'] };
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        return { kind: 'invalid', problems: ['is not valid JSON'] };
    }
    const result = FaultPlan.safeParse(json);
    if (result.success) return { kind: 'ok', plan: result.data };
    return {
        kind: 'invalid',
        problems: result.error.issues.map((issue) =>
            issue.code === 'unrecognized_keys'
                ? `${issue.path.join('.') || '(root)'}: unknown field`
                : `${issue.path.join('.') || '(root)'}: ${issue.code}`,
        ),
    };
}

const globCache = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
    let regexp = globCache.get(glob);
    if (regexp === undefined) {
        const source = glob
            .split('**')
            .map((part) =>
                part
                    .split('*')
                    .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
                    .join('[^/]*'),
            )
            .join('.*');
        regexp = new RegExp(`^${source}$`);
        globCache.set(glob, regexp);
    }
    return regexp;
}

export function matchesRoutes(plan: FaultPlan, path: string): boolean {
    return plan.routes === undefined || plan.routes.some((glob) => globToRegExp(glob).test(path));
}
