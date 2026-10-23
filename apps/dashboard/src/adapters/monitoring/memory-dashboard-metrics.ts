import type { Clock } from '../../domain/ports/clock';
import type { DashboardMetric, DashboardMetrics, MetricsQuery } from '../../domain/monitoring/dashboard-metrics';

/** Bounded, so a long dev session cannot grow it without limit. */
const MAX_RECORDS = 10_000;
const MINUTE_MS = 60_000;

export interface MemoryDashboardMetrics extends DashboardMetrics, MetricsQuery {
    readonly records: readonly { readonly at: number; readonly metric: DashboardMetric }[];
}

/** Dev and tests: the counters in memory, queried as Analytics Engine would answer them. */
export function createMemoryDashboardMetrics(clock: Clock): MemoryDashboardMetrics {
    const records: { readonly at: number; readonly metric: DashboardMetric }[] = [];
    return {
        records,
        record(metric) {
            records.push({ at: clock.nowMs(), metric });
            if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
        },
        dashboardCounts(minutes, signal) {
            if (signal.aborted) return Promise.reject(signal.reason as Error);
            const since = clock.nowMs() - minutes * MINUTE_MS;
            const counts = { heartbeatsAccepted: 0, heartbeatsRejected: 0, emailsSent: 0, emailsFailed: 0 };
            for (const { at, metric } of records) {
                if (at <= since) continue;
                if (metric.name === 'ptbk_dashboard_heartbeats_total') {
                    if (metric.outcome === 'accepted') counts.heartbeatsAccepted++;
                    else counts.heartbeatsRejected++;
                } else if (metric.name === 'ptbk_dashboard_emails_total') {
                    if (metric.outcome === 'sent') counts.emailsSent++;
                    else counts.emailsFailed++;
                }
            }
            return Promise.resolve(counts);
        },
    };
}
