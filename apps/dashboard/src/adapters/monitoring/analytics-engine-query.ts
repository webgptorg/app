import { z } from 'zod';

import type { DashboardCounts, MetricsQuery } from '../../domain/monitoring/dashboard-metrics';

export interface AnalyticsEngineQueryOptions {
    readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
    readonly accountId: string;
    readonly dataset: string;
    /** Account Analytics: Read, nothing else (docs/runbooks/observability.md). */
    readonly token: string;
}

const MAX_RESPONSE_BYTES = 64 * 1024;

const responseSchema = z.object({
    data: z.array(z.object({ name: z.string(), outcome: z.string(), n: z.coerce.number().nonnegative() })).max(100),
});

/** Reads the dashboard's counters back through Analytics Engine's SQL API. */
export function createAnalyticsEngineQuery(options: AnalyticsEngineQueryOptions): MetricsQuery {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(options.dataset)) throw new Error('invalid Analytics Engine dataset name');
    const url = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/analytics_engine/sql`;
    return {
        async dashboardCounts(minutes, signal) {
            if (!Number.isSafeInteger(minutes) || minutes < 1)
                throw new RangeError('minutes must be a positive integer');
            // `_sample_interval` restores the counts Analytics Engine sampled away at high volume.
            const sql = `SELECT blob1 AS name, blob2 AS outcome, SUM(_sample_interval * double1) AS n FROM ${options.dataset}
WHERE timestamp > NOW() - INTERVAL '${String(minutes)}' MINUTE
AND blob1 IN ('ptbk_dashboard_heartbeats_total', 'ptbk_dashboard_emails_total')
GROUP BY name, outcome FORMAT JSON`;
            const response = await options.fetch(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'text/plain' },
                body: sql,
                redirect: 'error',
                signal,
            });
            if (!response.ok) throw new Error(`Analytics Engine answered ${String(response.status)}`);
            const text = await response.text();
            if (text.length > MAX_RESPONSE_BYTES) throw new Error('Analytics Engine answer too large');
            const rows = responseSchema.parse(JSON.parse(text)).data;
            const sum = (name: string, keep: (outcome: string) => boolean): number =>
                rows.filter((row) => row.name === name && keep(row.outcome)).reduce((total, row) => total + row.n, 0);
            const heartbeats = 'ptbk_dashboard_heartbeats_total';
            const emails = 'ptbk_dashboard_emails_total';
            return {
                heartbeatsAccepted: sum(heartbeats, (outcome) => outcome === 'accepted'),
                heartbeatsRejected: sum(heartbeats, (outcome) => outcome !== 'accepted'),
                emailsSent: sum(emails, (outcome) => outcome === 'sent'),
                emailsFailed: sum(emails, (outcome) => outcome === 'failed'),
            } satisfies DashboardCounts;
        },
    };
}
