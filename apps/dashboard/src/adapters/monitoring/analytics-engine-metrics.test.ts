import { describe, expect, it } from 'vitest';

import type { DashboardMetric } from '../../domain/monitoring/dashboard-metrics';
import { createAnalyticsEngineMetrics, toDataPoint } from './analytics-engine-metrics';

/** Every kind of metric, as the dashboard records them. */
const EVERY_METRIC: readonly DashboardMetric[] = [
    { name: 'ptbk_dashboard_requests_total', route: '/v1/engines/:engineId/heartbeat', method: 'POST', status: 204 },
    { name: 'ptbk_dashboard_heartbeats_total', outcome: 'stale-ts' },
    { name: 'ptbk_dashboard_registrations_total', outcome: 'registered' },
    { name: 'ptbk_dashboard_alarms_total', object: 'engine-status' },
    { name: 'ptbk_dashboard_emails_total', template: 'engine-offline', outcome: 'failed' },
    { name: 'ptbk_dashboard_cron_runs_total', job: 'relay-monitor', outcome: 'ok', durationMs: 120 },
    { name: 'ptbk_monitor_relay_checks_total', relay: 'relay-a', outcome: 'timeout' },
    { name: 'ptbk_monitor_relay_health', relay: 'relay-a', values: [1, 2, 3] },
    { name: 'ptbk_monitor_relay_outcomes', relay: 'relay-a', values: [4] },
    { name: 'ptbk_monitor_dashboard_checks_total', healthy: false },
];

describe('toDataPoint', () => {
    it('puts the name first and the outcome second, within Analytics Engine limits', () => {
        for (const metric of EVERY_METRIC) {
            const point = toDataPoint(metric);
            expect(point.blobs[0]).toBe(metric.name);
            expect(point.blobs.length).toBeLessThanOrEqual(20);
            expect(point.doubles.length).toBeLessThanOrEqual(20);
        }
        expect(toDataPoint(EVERY_METRIC[0] as DashboardMetric)).toEqual({
            blobs: ['ptbk_dashboard_requests_total', '204', '/v1/engines/:engineId/heartbeat', 'POST'],
            doubles: [1],
        });
        expect(toDataPoint(EVERY_METRIC[5] as DashboardMetric).doubles).toEqual([1, 120]);
        expect(toDataPoint(EVERY_METRIC[9] as DashboardMetric).blobs).toEqual([
            'ptbk_monitor_dashboard_checks_total',
            'unhealthy',
        ]);
        expect(toDataPoint({ name: 'ptbk_monitor_dashboard_checks_total', healthy: true }).blobs[1]).toBe('healthy');
    });
});

describe('dashboard data points: label cardinality', () => {
    it('carry only closed values, route templates and our own relay and job names', () => {
        for (const metric of EVERY_METRIC) {
            for (const blob of toDataPoint(metric).blobs) {
                // No engine ID (26 base32 characters), hostname, IP address or email address.
                expect(blob).not.toMatch(
                    /(^|[^:a-z])[a-z2-7]{26}($|[^a-z])|[a-z0-9-]+\.[a-z0-9-]+\.|\d+\.\d+\.\d+\.\d+|@|::/,
                );
                expect(blob.length).toBeLessThanOrEqual(96);
            }
        }
    });
});

describe('createAnalyticsEngineMetrics', () => {
    it('writes one point per metric, indexed by its name, and swallows a refused write', () => {
        const points: unknown[] = [];
        const metrics = createAnalyticsEngineMetrics({ writeDataPoint: (point) => points.push(point) });
        metrics.record({ name: 'ptbk_dashboard_heartbeats_total', outcome: 'accepted' });
        expect(points).toEqual([
            {
                blobs: ['ptbk_dashboard_heartbeats_total', 'accepted'],
                doubles: [1],
                indexes: ['ptbk_dashboard_heartbeats_total'],
            },
        ]);
        const refusing = createAnalyticsEngineMetrics({
            writeDataPoint: () => {
                throw new Error('limit');
            },
        });
        expect(() => {
            refusing.record({ name: 'ptbk_dashboard_heartbeats_total', outcome: 'accepted' });
        }).not.toThrow();
    });
});
