import type { Hostname } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createMonitoringTestDeps } from '../../testing/test-monitoring';
import { MAX_DELIVERY_ATTEMPTS } from './alert-outbox';
import type { Alert, MonitorObservation, MonitorState } from './alert-rules';
import { DEFAULT_THRESHOLDS } from './alert-rules';
import { createMonitorService } from './monitor-store';
import type { MonitoringJobDeps } from './monitoring-job';
import { deliverAlerts, runMonitoring } from './monitoring-job';
import type { RelayProbe } from './relay-prober';

const T0 = Date.UTC(2026, 9, 23, 12);

function setup(probes: Readonly<Record<string, RelayProbe | 'throw'>>, overrides: Partial<MonitoringJobDeps> = {}) {
    const { clock, metrics, logger } = createMonitoringTestDeps(T0);
    const observed: MonitorObservation[] = [];
    const deps: MonitoringJobDeps = {
        relays: Object.keys(probes).map((relayId) => ({
            relayId: relayId as Hostname,
            name: relayId.split('.')[0] ?? relayId,
        })),
        prober: {
            probe: (relayId) => {
                const probe = probes[relayId];
                return probe === 'throw' || probe === undefined
                    ? Promise.reject(new Error('boom'))
                    : Promise.resolve(probe);
            },
        },
        dashboardHealthy: () => Promise.resolve(true),
        metrics,
        query: metrics,
        store: {
            observe: (observation) => {
                observed.push(observation);
                return Promise.resolve();
            },
        },
        thresholds: DEFAULT_THRESHOLDS,
        clock,
        logger,
        probeTimeoutMs: 5000,
        ...overrides,
    };
    return { deps, metrics, logger, observed };
}

describe('runMonitoring', () => {
    it('checks every relay, writes what it saw and hands the observation to the store', async () => {
        const { deps, metrics, observed } = setup({
            'relay-a.ptbk.test': { kind: 'up', metrics: 'ptbk_relay_tunnels_active 4\n' },
            'relay-b.ptbk.test': { kind: 'down', reason: 'healthz' },
            'relay-c.ptbk.test': 'throw',
        });
        metrics.record({ name: 'ptbk_dashboard_heartbeats_total', outcome: 'bad-signature' });
        await runMonitoring(deps, new AbortController().signal);
        expect(observed).toHaveLength(1);
        const [observation] = observed;
        expect(observation?.relays.map((check) => [check.relay, check.kind])).toEqual([
            ['relay-a', 'up'],
            ['relay-b', 'down'],
            ['relay-c', 'down'],
        ]);
        expect(observation?.relays[2]).toEqual({ relay: 'relay-c', kind: 'down', reason: 'tls' });
        expect(observation?.counts).toEqual({
            heartbeatsAccepted: 0,
            heartbeatsRejected: 1,
            emailsSent: 0,
            emailsFailed: 0,
        });
        expect(observation?.dashboardHealthy).toBe(true);
        const names = metrics.records.map((record) => record.metric.name);
        expect(names.filter((name) => name === 'ptbk_monitor_relay_checks_total')).toHaveLength(3);
        expect(names).toContain('ptbk_monitor_relay_health');
        expect(names).toContain('ptbk_monitor_relay_outcomes');
        expect(names).toContain('ptbk_monitor_dashboard_checks_total');
    });

    it('treats a failing self-check as unhealthy and unreadable counts as unknown', async () => {
        const { deps, observed, logger } = setup(
            {},
            {
                dashboardHealthy: () => Promise.reject(new Error('down')),
                query: { dashboardCounts: () => Promise.reject(new Error('no token')) },
            },
        );
        await runMonitoring(deps, new AbortController().signal);
        expect(observed[0]).toMatchObject({ dashboardHealthy: false, counts: null, relays: [] });
        expect(logger.entries.map((entry) => entry.event)).toContain('ops.counts-unavailable');
    });
});

describe('deliverAlerts', () => {
    function queued(subjects: readonly string[]) {
        let state: MonitorState | null = null;
        const store = createMonitorService({
            storage: {
                load: () => Promise.resolve(state),
                save: (next) => {
                    state = next;
                    return Promise.resolve();
                },
            },
            thresholds: { ...DEFAULT_THRESHOLDS, unreachableChecks: 1 },
        });
        return {
            store,
            ready: store.observe({
                at: T0,
                relays: subjects.map((relay) => ({ relay, kind: 'down', reason: 'tls' }) as const),
                dashboardHealthy: true,
                counts: null,
            }),
        };
    }

    it('sends every queued alert and empties the queue; a failed send stays queued for the next run', async () => {
        const { store, ready } = queued(['relay-a', 'relay-b']);
        await ready;
        const { metrics, logger } = createMonitoringTestDeps(T0);
        const sent: Alert[] = [];
        let failFirst = true;
        const alerts = {
            send: (alert: Alert) => {
                if (failFirst) {
                    failFirst = false;
                    return Promise.reject(new Error('smtp'));
                }
                sent.push(alert);
                return Promise.resolve();
            },
        };
        await deliverAlerts({ store, alerts, metrics, logger });
        expect(sent.map((alert) => alert.subject)).toEqual(['relay-b']);
        expect((await store.pending()).map((item) => [item.alert.subject, item.attempts])).toEqual([['relay-a', 1]]);
        await deliverAlerts({ store, alerts, metrics, logger });
        expect(sent.map((alert) => alert.subject)).toEqual(['relay-b', 'relay-a']);
        await expect(store.pending()).resolves.toEqual([]);
        expect(metrics.records.map((record) => record.metric)).toEqual([
            { name: 'ptbk_monitor_alert_deliveries_total', outcome: 'failed' },
            { name: 'ptbk_monitor_alert_deliveries_total', outcome: 'sent' },
            { name: 'ptbk_monitor_alert_deliveries_total', outcome: 'sent' },
        ]);
        expect(logger.entries).toContainEqual({
            level: 'error',
            event: 'ops.alert-failed',
            fields: { rule: 'relay-unreachable', subject: 'relay-a', state: 'firing', attempt: 1 },
        });
        await deliverAlerts({ store, alerts, metrics, logger });
        expect(metrics.records).toHaveLength(3);
    });

    it('drops an alert after the last failed attempt, counted and logged', async () => {
        const { store, ready } = queued(['relay-a']);
        await ready;
        const { metrics, logger } = createMonitoringTestDeps(T0);
        const alerts = { send: () => Promise.reject(new Error('smtp')) };
        for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
            await deliverAlerts({ store, alerts, metrics, logger });
        }
        await expect(store.pending()).resolves.toEqual([]);
        expect(metrics.records.at(-1)?.metric).toEqual({
            name: 'ptbk_monitor_alert_deliveries_total',
            outcome: 'dropped',
        });
        expect(logger.entries.map((entry) => entry.event)).toContain('ops.alert-dropped');
    });

    it('only logs alerts without a sink, which counts as delivered', async () => {
        const { store, ready } = queued(['relay-a']);
        await ready;
        const { metrics, logger } = createMonitoringTestDeps(T0);
        await deliverAlerts({ store, alerts: null, metrics, logger });
        expect(logger.entries.map((entry) => entry.event)).toEqual(['ops.alert']);
        await expect(store.pending()).resolves.toEqual([]);
    });
});
