import { z } from 'zod';

import type { DashboardCounts } from './dashboard-metrics';
import type { RelaySample } from './relay-sample';
import { registryLookups } from './relay-sample';

export const ALERT_RULES = [
    'relay-unreachable',
    'relay-tunnels-dropped',
    'relay-registry-errors',
    'relay-certificate-expiring',
    'dashboard-unhealthy',
    'heartbeat-rejections',
    'email-failures',
    'cron-job-failing',
] as const;
export type AlertRule = (typeof ALERT_RULES)[number];

/** The initial thresholds (I-04); `MONITORING.thresholds` overrides any of them per environment. */
export const DEFAULT_THRESHOLDS = {
    /** Failed checks in a row, one a minute, before a relay (or the dashboard itself) counts as down. */
    unreachableChecks: 2,
    /** Active tunnels fall by more than this share within the window... */
    tunnelDropPercent: 50,
    tunnelDropWindowMinutes: 5,
    /** ...from at least this many, so one engine going away is not an alert. */
    tunnelDropMinTunnels: 2,
    /** Registry lookups answered `stale` or `error`, over the window, above this share... */
    registryProblemPercent: 5,
    registryWindowMinutes: 10,
    /** ...out of at least this many lookups. */
    registryMinLookups: 20,
    /** Heartbeats refused within the window: at least this many, and this share of all heartbeats. */
    heartbeatRejectionWindowMinutes: 10,
    heartbeatRejectionMinCount: 20,
    heartbeatRejectionPercent: 10,
    certificateExpiryDays: 14,
    /** Failed runs of one scheduled job in a row. */
    cronFailures: 3,
    /** Emails the provider refused within the window. */
    emailFailureWindowMinutes: 10,
    emailFailureMinCount: 1,
} as const satisfies Readonly<Record<string, number>>;

export type AlertThresholds = { readonly [K in keyof typeof DEFAULT_THRESHOLDS]: number };

/** Every threshold a positive integer (percentages up to 100), as config parses it. */
export const thresholdsSchema = z
    .strictObject(
        Object.fromEntries(
            Object.keys(DEFAULT_THRESHOLDS).map((key) => [
                key,
                z
                    .int()
                    .min(1)
                    .max(key.endsWith('Percent') ? 100 : 10_000)
                    .optional(),
            ]),
        ) as Record<keyof typeof DEFAULT_THRESHOLDS, z.ZodOptional<z.ZodInt>>,
    )
    .transform((overrides): AlertThresholds => {
        const set = Object.entries(overrides).filter(([, value]) => value !== undefined);
        return Object.freeze({ ...DEFAULT_THRESHOLDS, ...Object.fromEntries(set) });
    });

/** What an alert says: which rule, about what (a relay's short name, a job, `dashboard`), and numbers only. */
export interface Alert {
    readonly rule: AlertRule;
    readonly subject: string;
    readonly state: 'firing' | 'resolved';
    readonly at: number;
    readonly detail: Readonly<Record<string, number>>;
}

export type RelayCheck =
    | { readonly relay: string; readonly kind: 'up'; readonly sample: RelaySample }
    /** `tls` covers DNS, connect and handshake failures; `healthz` and `metrics` a wrong answer; `timeout` either. */
    | { readonly relay: string; readonly kind: 'down'; readonly reason: 'tls' | 'healthz' | 'metrics' | 'timeout' };

/** One monitoring run's view (one a minute). */
export interface MonitorObservation {
    readonly at: number;
    readonly relays: readonly RelayCheck[];
    readonly dashboardHealthy: boolean;
    /** Null when the counts could not be read; the rules that need them then keep their state. */
    readonly counts: DashboardCounts | null;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Samples kept per relay: enough for the longest window at one a minute, with room for a late run. */
const MAX_SAMPLES = 30;

const relaySampleSchema = z.strictObject({
    at: z.number(),
    tunnels: z.number().nullable(),
    lookups: z.strictObject({ total: z.number(), problems: z.number() }).nullable(),
});

export const monitorStateSchema = z.strictObject({
    v: z.literal(1),
    relays: z.record(
        z.string(),
        z.strictObject({ failures: z.int().min(0), samples: z.array(relaySampleSchema).max(MAX_SAMPLES) }),
    ),
    dashboardFailures: z.int().min(0),
    jobs: z.record(z.string(), z.strictObject({ failures: z.int().min(0) })),
    /** Firing alerts by `rule:subject`, with when they started. */
    open: z.record(z.string(), z.strictObject({ since: z.number() })),
});
export type MonitorState = z.infer<typeof monitorStateSchema>;
type RelayState = MonitorState['relays'][string];
type StoredSample = RelayState['samples'][number];

export const INITIAL_MONITOR_STATE: MonitorState = { v: 1, relays: {}, dashboardFailures: 0, jobs: {}, open: {} };

export interface Evaluation {
    readonly state: MonitorState;
    /** Alerts that started or ended with this observation, in rule order. */
    readonly alerts: readonly Alert[];
}

interface Transitions {
    readonly open: Readonly<Record<string, { readonly since: number }>>;
    readonly alerts: readonly Alert[];
    /** `firing: null` leaves the alert as it is (the rule could not be evaluated). */
    apply(rule: AlertRule, subject: string, firing: boolean | null, detail: Readonly<Record<string, number>>): void;
}

function createTransitions(initial: MonitorState['open'], at: number): Transitions {
    const open = new Map(Object.entries(initial));
    const alerts: Alert[] = [];
    return {
        get open() {
            return Object.fromEntries(open);
        },
        alerts,
        apply(rule, subject, firing, detail) {
            if (firing === null) return;
            const key = `${rule}:${subject}`;
            if (firing === open.has(key)) return;
            if (firing) open.set(key, { since: at });
            else open.delete(key);
            alerts.push({ rule, subject, state: firing ? 'firing' : 'resolved', at, detail });
        },
    };
}

function tunnelDrop(
    samples: readonly StoredSample[],
    current: StoredSample,
    thresholds: AlertThresholds,
): { readonly firing: boolean | null; readonly detail: Readonly<Record<string, number>> } {
    if (current.tunnels === null) return { firing: null, detail: {} };
    const since = current.at - thresholds.tunnelDropWindowMinutes * MINUTE_MS;
    const earlier = samples.filter((sample) => sample.at >= since && sample.at < current.at);
    const peak = Math.max(0, ...earlier.flatMap((sample) => (sample.tunnels === null ? [] : [sample.tunnels])));
    const firing =
        peak >= thresholds.tunnelDropMinTunnels &&
        current.tunnels < (peak * (100 - thresholds.tunnelDropPercent)) / 100;
    return { firing, detail: { fromTunnels: peak, toTunnels: current.tunnels } };
}

function registryProblems(
    samples: readonly StoredSample[],
    current: StoredSample,
    thresholds: AlertThresholds,
): { readonly firing: boolean | null; readonly detail: Readonly<Record<string, number>> } {
    if (current.lookups === null) return { firing: null, detail: {} };
    const since = current.at - thresholds.registryWindowMinutes * MINUTE_MS;
    // The oldest sample within the window: the rate is over (nearly) the whole window, not the last minute.
    const base = samples.find((sample) => sample.at >= since && sample.at < current.at && sample.lookups !== null);
    if (base?.lookups == null) return { firing: null, detail: {} };
    const total = current.lookups.total - base.lookups.total;
    const problems = current.lookups.problems - base.lookups.problems;
    // A restarted relay counts from zero again; its first window says nothing.
    if (total < 0 || problems < 0) return { firing: null, detail: {} };
    const firing = total >= thresholds.registryMinLookups && problems * 100 > total * thresholds.registryProblemPercent;
    return { firing, detail: { lookups: total, problems } };
}

function storedSample(at: number, sample: RelaySample): StoredSample {
    const lookups = registryLookups(sample);
    return {
        at,
        tunnels: sample.values.get('ptbk_relay_tunnels_active') ?? null,
        lookups:
            lookups === null
                ? null
                : {
                      total: lookups.fresh + lookups.miss + lookups.stale + lookups.error,
                      problems: lookups.stale + lookups.error,
                  },
    };
}

function evaluateRelay(
    check: RelayCheck,
    previous: RelayState | undefined,
    at: number,
    thresholds: AlertThresholds,
    transitions: Transitions,
): RelayState {
    const state = previous ?? { failures: 0, samples: [] };
    const { relay } = check;
    if (check.kind === 'down') {
        const failures = state.failures + 1;
        transitions.apply('relay-unreachable', relay, failures >= thresholds.unreachableChecks ? true : null, {
            failedChecks: failures,
        });
        return { ...state, failures };
    }
    transitions.apply('relay-unreachable', relay, false, { failedChecks: 0 });
    const current = storedSample(at, check.sample);
    const drop = tunnelDrop(state.samples, current, thresholds);
    transitions.apply('relay-tunnels-dropped', relay, drop.firing, drop.detail);
    const registry = registryProblems(state.samples, current, thresholds);
    transitions.apply('relay-registry-errors', relay, registry.firing, registry.detail);
    const expiresAtS = check.sample.values.get('ptbk_relay_certificate_expiry_timestamp_seconds');
    const daysLeft = expiresAtS === undefined ? null : Math.floor((expiresAtS * 1000 - at) / DAY_MS);
    transitions.apply(
        'relay-certificate-expiring',
        relay,
        daysLeft === null ? null : daysLeft < thresholds.certificateExpiryDays,
        daysLeft === null ? {} : { daysLeft },
    );
    const keepSince =
        at - Math.max(thresholds.tunnelDropWindowMinutes, thresholds.registryWindowMinutes) * MINUTE_MS - MINUTE_MS;
    const samples = [...state.samples.filter((sample) => sample.at >= keepSince), current].slice(-MAX_SAMPLES);
    return { failures: 0, samples };
}

function evaluateCounts(counts: DashboardCounts | null, thresholds: AlertThresholds, transitions: Transitions): void {
    if (counts === null) return;
    const total = counts.heartbeatsAccepted + counts.heartbeatsRejected;
    const rejected = counts.heartbeatsRejected;
    transitions.apply(
        'heartbeat-rejections',
        'dashboard',
        rejected >= thresholds.heartbeatRejectionMinCount &&
            rejected * 100 >= total * thresholds.heartbeatRejectionPercent,
        { rejected, heartbeats: total },
    );
    transitions.apply('email-failures', 'dashboard', counts.emailsFailed >= thresholds.emailFailureMinCount, {
        failed: counts.emailsFailed,
        sent: counts.emailsSent,
    });
}

/** One monitoring run: the next state and the alerts that start or end with it. Pure, so the rules are unit-tested. */
export function evaluateAlerts(
    state: MonitorState,
    observation: MonitorObservation,
    thresholds: AlertThresholds,
): Evaluation {
    const { at } = observation;
    const transitions = createTransitions(state.open, at);
    const relays: Record<string, RelayState> = {};
    for (const check of observation.relays) {
        relays[check.relay] = evaluateRelay(check, state.relays[check.relay], at, thresholds, transitions);
    }
    const dashboardFailures = observation.dashboardHealthy ? 0 : state.dashboardFailures + 1;
    transitions.apply(
        'dashboard-unhealthy',
        'dashboard',
        observation.dashboardHealthy ? false : dashboardFailures >= thresholds.unreachableChecks ? true : null,
        { failedChecks: dashboardFailures },
    );
    evaluateCounts(observation.counts, thresholds, transitions);
    // A relay no longer configured is forgotten, with its open alerts.
    const relayRule = /^relay-[a-z-]+:(.+)$/;
    const open = Object.fromEntries(
        Object.entries(transitions.open).filter(([key]) => {
            const relay = relayRule.exec(key)?.[1];
            return relay === undefined || relay in relays;
        }),
    );
    return { state: { ...state, relays, dashboardFailures, open }, alerts: transitions.alerts };
}

export interface JobRun {
    readonly job: string;
    readonly outcome: 'ok' | 'failed';
    readonly at: number;
}

/** A scheduled job's run: its failure streak, and the alert at the streak's threshold or on its first success after. */
export function recordJobRun(state: MonitorState, run: JobRun, thresholds: AlertThresholds): Evaluation {
    const transitions = createTransitions(state.open, run.at);
    const failures = run.outcome === 'ok' ? 0 : (state.jobs[run.job]?.failures ?? 0) + 1;
    transitions.apply(
        'cron-job-failing',
        run.job,
        run.outcome === 'ok' ? false : failures >= thresholds.cronFailures ? true : null,
        {
            failedRuns: failures,
        },
    );
    return {
        state: { ...state, jobs: { ...state.jobs, [run.job]: { failures } }, open: transitions.open },
        alerts: transitions.alerts,
    };
}
