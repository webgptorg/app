import type { Hostname } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createMonitoringTestDeps } from '../../testing/test-monitoring';
import type { Alert, MonitorObservation } from './alert-rules';
import { DEFAULT_THRESHOLDS } from './alert-rules';
import type { MonitoringJobDeps } from './monitoring-job';
import { deliverAlerts, runMonitoring } from './monitoring-job';
import type { RelayProbe } from './relay-prober';

const T0 = Date.UTC(2026, 9, 23, 12);
const alert: Alert = { rule: 'relay-unreachable', subject: 'relay-a', state: 'firing', at: T0, detail: {} };

function setup(probes: Readonly<Record<string, RelayProbe | 'throw'>>, overrides: Partial<MonitoringJobDeps> = {}) {
    const { clock, metrics, logger } = createMonitoringTestDeps(T0);
    const observed: MonitorObservation[] = [];
    const sent: Alert[] = [];
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
                return Promise.resolve([alert]);
            },
        },
        alerts: {
            send: (fired) => {
                sent.push(fired);
                return Promise.resolve();
            },
        },
        thresholds: DEFAULT_THRESHOLDS,
        clock,
        logger,
        probeTimeoutMs: 5000,
        ...overrides,
    };
    return { deps, metrics, logger, observed, sent };
}

describe('runMonitoring', () => {
    it('checks every relay, writes what it saw, hands the observation to the store and sends its alerts', async () => {
        const { deps, metrics, observed, sent, logger } = setup({
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
        expect(sent).toEqual([alert]);
        expect(logger.entries).toContainEqual({
            level: 'warn',
            event: 'ops.alert',
            fields: { rule: 'relay-unreachable', subject: 'relay-a', state: 'firing' },
        });
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
    it('logs alerts without a sink, and logs a failed send without stopping the others', async () => {
        const { logger } = createMonitoringTestDeps();
        await deliverAlerts([alert], { alerts: null, logger });
        expect(logger.entries.map((entry) => entry.event)).toEqual(['ops.alert']);
        const sent: Alert[] = [];
        let first = true;
        await deliverAlerts([alert, { ...alert, subject: 'relay-b' }], {
            logger,
            alerts: {
                send: (fired) => {
                    if (first) {
                        first = false;
                        return Promise.reject(new Error('smtp'));
                    }
                    sent.push(fired);
                    return Promise.resolve();
                },
            },
        });
        expect(sent.map((fired) => fired.subject)).toEqual(['relay-b']);
        expect(logger.entries.map((entry) => entry.event)).toContain('ops.alert-failed');
    });
});
