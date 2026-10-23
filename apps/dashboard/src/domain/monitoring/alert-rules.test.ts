import { describe, expect, it } from 'vitest';

import type { MonitorObservation, MonitorState, RelayCheck } from './alert-rules';
import {
    DEFAULT_THRESHOLDS,
    INITIAL_MONITOR_STATE,
    evaluateAlerts,
    monitorStateSchema,
    recordJobRun,
    thresholdsSchema,
} from './alert-rules';
import type { DashboardCounts } from './dashboard-metrics';
import type { RelaySample } from './relay-sample';

const MINUTE = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 23, 12, 0);

interface RelayValues {
    readonly tunnels?: number;
    /** fresh, miss, stale, error */
    readonly lookups?: readonly [number, number, number, number];
    readonly certificateDays?: number;
}

function sample(at: number, values: RelayValues = {}): RelaySample {
    const map = new Map<string, number>();
    if (values.tunnels !== undefined) map.set('ptbk_relay_tunnels_active', values.tunnels);
    if (values.lookups !== undefined) {
        ['fresh', 'miss', 'stale', 'error'].forEach((result, index) => {
            map.set(`ptbk_relay_registry_lookups_total{result="${result}"}`, values.lookups?.[index] ?? 0);
        });
    }
    if (values.certificateDays !== undefined) {
        map.set('ptbk_relay_certificate_expiry_timestamp_seconds', (at + values.certificateDays * DAY) / 1000);
    }
    return { values: map };
}

const up = (relay: string, at: number, values?: RelayValues): RelayCheck => ({
    relay,
    kind: 'up',
    sample: sample(at, values),
});
const down = (relay: string): RelayCheck => ({ relay, kind: 'down', reason: 'tls' });
const quietCounts: DashboardCounts = { heartbeatsAccepted: 100, heartbeatsRejected: 0, emailsSent: 1, emailsFailed: 0 };

function observation(at: number, relays: readonly RelayCheck[], extra: Partial<MonitorObservation> = {}) {
    return { at, relays, dashboardHealthy: true, counts: quietCounts, ...extra } satisfies MonitorObservation;
}

/** Feeds observations one minute apart and collects every alert, as `rule state subject`. */
function run(observations: readonly MonitorObservation[], state: MonitorState = INITIAL_MONITOR_STATE) {
    const alerts: string[] = [];
    let current = state;
    for (const next of observations) {
        const evaluation = evaluateAlerts(current, next, DEFAULT_THRESHOLDS);
        current = evaluation.state;
        alerts.push(...evaluation.alerts.map((alert) => `${alert.rule} ${alert.state} ${alert.subject}`));
    }
    return { alerts, state: current };
}

describe('relay-unreachable', () => {
    it('fires on the second failed check in a row, once, and resolves on the next good one', () => {
        const at = (minute: number) => T0 + minute * MINUTE;
        const { alerts, state } = run([
            observation(at(0), [up('relay-a', at(0)), up('relay-b', at(0))]),
            observation(at(1), [down('relay-a'), up('relay-b', at(1))]),
            observation(at(2), [down('relay-a'), up('relay-b', at(2))]),
            observation(at(3), [down('relay-a'), up('relay-b', at(3))]),
            observation(at(4), [up('relay-a', at(4)), up('relay-b', at(4))]),
        ]);
        expect(alerts).toEqual(['relay-unreachable firing relay-a', 'relay-unreachable resolved relay-a']);
        expect(state.open).toEqual({});
        expect(state.relays['relay-a']?.failures).toBe(0);
    });

    it('does not fire on a single failed check', () => {
        expect(run([observation(T0, [down('relay-a')]), observation(T0 + MINUTE, [up('relay-a', T0)])]).alerts).toEqual(
            [],
        );
    });

    it('carries the number of failed checks and the time', () => {
        const first = evaluateAlerts(INITIAL_MONITOR_STATE, observation(T0, [down('relay-a')]), DEFAULT_THRESHOLDS);
        const second = evaluateAlerts(first.state, observation(T0 + MINUTE, [down('relay-a')]), DEFAULT_THRESHOLDS);
        expect(second.alerts).toEqual([
            {
                rule: 'relay-unreachable',
                subject: 'relay-a',
                state: 'firing',
                at: T0 + MINUTE,
                detail: { failedChecks: 2 },
            },
        ]);
        expect(second.state.open).toEqual({ 'relay-unreachable:relay-a': { since: T0 + MINUTE } });
    });
});

describe('relay-tunnels-dropped', () => {
    const at = (minute: number) => T0 + minute * MINUTE;

    it('fires on a fall by more than half within five minutes and stays open while the relay stays empty', () => {
        const { alerts, state } = run([
            observation(at(0), [up('relay-a', at(0), { tunnels: 100 })]),
            observation(at(1), [up('relay-a', at(1), { tunnels: 60 })]),
            observation(at(2), [up('relay-a', at(2), { tunnels: 49 })]),
            observation(at(3), [up('relay-a', at(3), { tunnels: 49 })]),
            // The 100 has long left the window; the alert remembers it.
            observation(at(20), [up('relay-a', at(20), { tunnels: 49 })]),
            observation(at(21), [up('relay-a', at(21), { tunnels: 79 })]),
        ]);
        expect(alerts).toEqual(['relay-tunnels-dropped firing relay-a']);
        expect(state.open['relay-tunnels-dropped:relay-a']).toEqual({ since: at(2), peak: 100 });
    });

    it('resolves once tunnels are back to 80 % of the peak they fell from', () => {
        const { alerts, state } = run([
            observation(at(0), [up('relay-a', at(0), { tunnels: 100 })]),
            observation(at(1), [up('relay-a', at(1), { tunnels: 10 })]),
            observation(at(30), [up('relay-a', at(30), { tunnels: 80 })]),
        ]);
        expect(alerts).toEqual(['relay-tunnels-dropped firing relay-a', 'relay-tunnels-dropped resolved relay-a']);
        expect(state.open).toEqual({});
    });

    it('resolves when the relay comes back from being down, without firing again on the reconnect', () => {
        const { alerts } = run([
            observation(at(0), [up('relay-a', at(0), { tunnels: 100 })]),
            observation(at(1), [up('relay-a', at(1), { tunnels: 10 })]),
            observation(at(2), [down('relay-a')]),
            observation(at(3), [up('relay-a', at(3), { tunnels: 3 })]),
            observation(at(4), [up('relay-a', at(4), { tunnels: 40 })]),
        ]);
        expect(alerts).toEqual(['relay-tunnels-dropped firing relay-a', 'relay-tunnels-dropped resolved relay-a']);
    });

    it('keeps an open drop while the relay does not report its tunnels, and reads a stored drop without a peak', () => {
        const open = run([
            observation(at(0), [up('relay-a', at(0), { tunnels: 100 })]),
            observation(at(1), [up('relay-a', at(1), { tunnels: 10 })]),
            observation(at(2), [up('relay-a', at(2))]),
        ]);
        expect(open.alerts).toEqual(['relay-tunnels-dropped firing relay-a']);
        const legacy: MonitorState = { ...open.state, open: { 'relay-tunnels-dropped:relay-a': { since: at(1) } } };
        expect(run([observation(at(3), [up('relay-a', at(3), { tunnels: 0 })])], legacy).alerts).toEqual([
            'relay-tunnels-dropped resolved relay-a',
        ]);
    });

    it('ignores a fall from fewer than two tunnels and a fall of exactly half', () => {
        expect(
            run([
                observation(T0, [up('relay-a', T0, { tunnels: 1 })]),
                observation(T0 + MINUTE, [up('relay-a', T0 + MINUTE, { tunnels: 0 })]),
            ]).alerts,
        ).toEqual([]);
        expect(
            run([
                observation(T0, [up('relay-a', T0, { tunnels: 10 })]),
                observation(T0 + MINUTE, [up('relay-a', T0 + MINUTE, { tunnels: 5 })]),
            ]).alerts,
        ).toEqual([]);
    });

    it('says nothing while a relay does not report its tunnels', () => {
        const { alerts } = run([
            observation(T0, [up('relay-a', T0, { tunnels: 100 })]),
            observation(T0 + MINUTE, [up('relay-a', T0 + MINUTE)]),
            observation(T0 + 2 * MINUTE, [up('relay-a', T0 + 2 * MINUTE, { tunnels: 10 })]),
        ]);
        expect(alerts).toEqual(['relay-tunnels-dropped firing relay-a']);
    });
});

describe('relay-registry-errors', () => {
    const at = (minute: number) => T0 + minute * MINUTE;

    it('fires when stale and error answers exceed 5 % of lookups over ten minutes, and resolves after', () => {
        const { alerts } = run([
            observation(at(0), [up('relay-a', at(0), { lookups: [0, 0, 0, 0] })]),
            observation(at(5), [up('relay-a', at(5), { lookups: [90, 4, 3, 3] })]),
            observation(at(10), [up('relay-a', at(10), { lookups: [500, 10, 3, 3] })]),
            observation(at(20), [up('relay-a', at(20), { lookups: [990, 10, 3, 3] })]),
        ]);
        expect(alerts).toEqual(['relay-registry-errors firing relay-a', 'relay-registry-errors resolved relay-a']);
    });

    it('needs enough lookups, a sample in the window and counters that did not restart', () => {
        expect(
            run([
                observation(at(0), [up('relay-a', at(0), { lookups: [0, 0, 0, 0] })]),
                observation(at(1), [up('relay-a', at(1), { lookups: [5, 5, 5, 4] })]),
            ]).alerts,
        ).toEqual([]);
        expect(
            run([
                observation(at(0), [up('relay-a', at(0), { lookups: [0, 0, 50, 50] })]),
                observation(at(11), [up('relay-a', at(11), { lookups: [0, 0, 100, 100] })]),
            ]).alerts,
        ).toEqual([]);
        expect(
            run([
                observation(at(0), [up('relay-a', at(0), { lookups: [1000, 0, 0, 0] })]),
                observation(at(1), [up('relay-a', at(1), { lookups: [0, 0, 50, 50] })]),
            ]).alerts,
        ).toEqual([]);
        expect(
            run([
                observation(at(0), [up('relay-a', at(0), { tunnels: 1 })]),
                observation(at(1), [up('relay-a', at(1), { lookups: [0, 0, 50, 50] })]),
            ]).alerts,
        ).toEqual([]);
    });
});

describe('relay-certificate-expiring', () => {
    it('fires under 14 days left and resolves once renewed', () => {
        const { alerts } = run([
            observation(T0, [up('relay-a', T0, { certificateDays: 30 })]),
            observation(T0 + MINUTE, [up('relay-a', T0 + MINUTE, { certificateDays: 13.9 })]),
            observation(T0 + 2 * MINUTE, [up('relay-a', T0 + 2 * MINUTE, { certificateDays: 89 })]),
        ]);
        expect(alerts).toEqual([
            'relay-certificate-expiring firing relay-a',
            'relay-certificate-expiring resolved relay-a',
        ]);
    });
});

describe('dashboard-unhealthy', () => {
    it('fires after two failed self-checks and resolves on a good one', () => {
        const { alerts } = run([
            observation(T0, [], { dashboardHealthy: false }),
            observation(T0 + MINUTE, [], { dashboardHealthy: false }),
            observation(T0 + 2 * MINUTE, []),
        ]);
        expect(alerts).toEqual(['dashboard-unhealthy firing dashboard', 'dashboard-unhealthy resolved dashboard']);
    });
});

describe('heartbeat-rejections and email-failures', () => {
    it('fire on a spike of refused heartbeats and on any failed email, and resolve when the window is quiet', () => {
        const spike: DashboardCounts = {
            heartbeatsAccepted: 100,
            heartbeatsRejected: 20,
            emailsSent: 3,
            emailsFailed: 1,
        };
        const { alerts } = run([
            observation(T0, [], { counts: spike }),
            observation(T0 + MINUTE, [], { counts: null }),
            observation(T0 + 2 * MINUTE, []),
        ]);
        expect(alerts).toEqual([
            'heartbeat-rejections firing dashboard',
            'email-failures firing dashboard',
            'heartbeat-rejections resolved dashboard',
            'email-failures resolved dashboard',
        ]);
    });

    it('ignores a few refusals among many heartbeats', () => {
        const counts = { heartbeatsAccepted: 10_000, heartbeatsRejected: 50, emailsSent: 0, emailsFailed: 0 };
        expect(run([observation(T0, [], { counts })]).alerts).toEqual([]);
    });
});

describe('relays leaving the configuration', () => {
    it('are forgotten with their open alerts, silently', () => {
        const { state } = run([
            observation(T0, [down('relay-a'), up('relay-b', T0)]),
            observation(T0 + MINUTE, [down('relay-a'), up('relay-b', T0 + MINUTE)]),
        ]);
        expect(state.open).toHaveProperty(['relay-unreachable:relay-a']);
        const after = run([observation(T0 + 2 * MINUTE, [up('relay-b', T0 + 2 * MINUTE)])], state);
        expect(after.alerts).toEqual([]);
        expect(after.state.open).toEqual({});
        expect(Object.keys(after.state.relays)).toEqual(['relay-b']);
    });

    it('keep the dashboard alerts', () => {
        const { state } = run([
            observation(T0, [], { dashboardHealthy: false }),
            observation(T0 + MINUTE, [], { dashboardHealthy: false }),
        ]);
        expect(Object.keys(state.open)).toEqual(['dashboard-unhealthy:dashboard']);
    });
});

describe('samples', () => {
    it('keeps only what the longest window needs, and round-trips through the stored schema', () => {
        const observations = Array.from({ length: 40 }, (_, minute) =>
            observation(T0 + minute * MINUTE, [
                up('relay-a', T0 + minute * MINUTE, { tunnels: 5, lookups: [1, 1, 0, 0] }),
            ]),
        );
        const { state } = run(observations);
        const samples = state.relays['relay-a']?.samples ?? [];
        expect(samples.length).toBeLessThanOrEqual(12);
        expect(samples.at(-1)?.at).toBe(T0 + 39 * MINUTE);
        expect(monitorStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
    });
});

describe('recordJobRun', () => {
    it('fires on the third failed run in a row and resolves on the next success', () => {
        let state = INITIAL_MONITOR_STATE;
        const alerts: string[] = [];
        for (const [index, outcome] of (['failed', 'failed', 'failed', 'failed', 'ok', 'ok'] as const).entries()) {
            const next = recordJobRun(
                state,
                { job: 'relay-monitor', outcome, at: T0 + index * MINUTE },
                DEFAULT_THRESHOLDS,
            );
            state = next.state;
            alerts.push(
                ...next.alerts.map(
                    (alert) => `${alert.rule} ${alert.state} ${alert.subject} ${String(alert.detail['failedRuns'])}`,
                ),
            );
        }
        expect(alerts).toEqual([
            'cron-job-failing firing relay-monitor 3',
            'cron-job-failing resolved relay-monitor 0',
        ]);
        expect(state.jobs).toEqual({ 'relay-monitor': { failures: 0 } });
    });
});

describe('thresholdsSchema', () => {
    it('fills in the defaults around overrides', () => {
        expect(thresholdsSchema.parse({ cronFailures: 5 })).toEqual({ ...DEFAULT_THRESHOLDS, cronFailures: 5 });
        expect(thresholdsSchema.parse({})).toEqual(DEFAULT_THRESHOLDS);
    });
});
