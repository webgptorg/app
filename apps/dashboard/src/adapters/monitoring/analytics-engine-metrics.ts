import type { DashboardMetric, DashboardMetrics } from '../../domain/monitoring/dashboard-metrics';

/** The part of Workers' `AnalyticsEngineDataset` binding this adapter uses. */
export interface AnalyticsEngineWriter {
    writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

export interface DataPoint {
    readonly blobs: string[];
    readonly doubles: number[];
}

/**
 * One data point per metric. `blob1` is always the metric name and `blob2` its outcome where it has one, so the SQL
 * in docs/runbooks/observability.md reads every counter the same way; `double1` is the count.
 */
export function toDataPoint(metric: DashboardMetric): DataPoint {
    switch (metric.name) {
        case 'ptbk_dashboard_requests_total':
            return { blobs: [metric.name, String(metric.status), metric.route, metric.method], doubles: [1] };
        case 'ptbk_dashboard_heartbeats_total':
        case 'ptbk_dashboard_registrations_total':
            return { blobs: [metric.name, metric.outcome], doubles: [1] };
        case 'ptbk_dashboard_alarms_total':
            return { blobs: [metric.name, 'fired', metric.object], doubles: [1] };
        case 'ptbk_dashboard_emails_total':
            return { blobs: [metric.name, metric.outcome, metric.template], doubles: [1] };
        case 'ptbk_dashboard_cron_runs_total':
            return { blobs: [metric.name, metric.outcome, metric.job], doubles: [1, metric.durationMs] };
        case 'ptbk_monitor_relay_checks_total':
            return { blobs: [metric.name, metric.outcome, metric.relay], doubles: [1] };
        case 'ptbk_monitor_relay_health':
        case 'ptbk_monitor_relay_outcomes':
            return { blobs: [metric.name, '', metric.relay], doubles: [...metric.values] };
        case 'ptbk_monitor_dashboard_checks_total':
            return { blobs: [metric.name, metric.healthy ? 'healthy' : 'unhealthy'], doubles: [1] };
    }
}

/** Workers Analytics Engine: fire and forget, so a lost data point never fails a request or a job. */
export function createAnalyticsEngineMetrics(dataset: AnalyticsEngineWriter): DashboardMetrics {
    return {
        record(metric) {
            const point = toDataPoint(metric);
            try {
                dataset.writeDataPoint({ ...point, indexes: [metric.name] });
            } catch {
                // Analytics Engine drops points over its per-invocation limit; monitoring must not fail the caller.
            }
        },
    };
}
