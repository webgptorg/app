import type { HeartbeatIngestOutcome } from '../status/ingest-heartbeat';
import type { RegisterOutcome } from '../registration/register-engine';
import type { EmailTemplate } from '../ports/email-sender';

export const HEARTBEAT_OUTCOMES = [
    'accepted',
    'unknown-engine',
    'engine-suspended',
    'bad-signature-header',
    'bad-signature',
    'invalid-body',
    'engine-mismatch',
    'replayed-seq',
    'stale-ts',
] as const satisfies readonly HeartbeatIngestOutcome['kind'][];

export const REGISTRATION_OUTCOMES = [
    'registered',
    'invalid-link-code',
    'bad-signature',
    'engine-suspended',
    'engine-exists',
    'not-entitled',
    'engine-limit',
] as const satisfies readonly RegisterOutcome['kind'][];

export const EMAIL_OUTCOMES = ['sent', 'failed'] as const;
export const JOB_OUTCOMES = ['ok', 'failed'] as const;

/**
 * One event the dashboard counts (I-04). Every label is a closed value or a route template from the route table, so
 * nothing here can name an engine, a hostname, an address, a person or an account: a route is `/v1/engines/:engineId`,
 * never its path.
 */
export type DashboardMetric =
    | {
          readonly name: 'ptbk_dashboard_requests_total';
          /** The matched route's template (`/v1/engines/:engineId/heartbeat`), `assets` or `unmatched`. */
          readonly route: string;
          readonly method: string;
          readonly status: number;
      }
    | {
          readonly name: 'ptbk_dashboard_heartbeats_total';
          readonly outcome: (typeof HEARTBEAT_OUTCOMES)[number];
      }
    | {
          readonly name: 'ptbk_dashboard_registrations_total';
          readonly outcome: (typeof REGISTRATION_OUTCOMES)[number];
      }
    | { readonly name: 'ptbk_dashboard_alarms_total'; readonly object: 'engine-status' }
    | {
          readonly name: 'ptbk_dashboard_emails_total';
          readonly template: EmailTemplate;
          readonly outcome: (typeof EMAIL_OUTCOMES)[number];
      }
    | {
          readonly name: 'ptbk_dashboard_cron_runs_total';
          /** A registered job's name. */
          readonly job: string;
          readonly outcome: (typeof JOB_OUTCOMES)[number];
          readonly durationMs: number;
      }
    | {
          /** One relay check: `up`, or why it failed. `relay` is the relay's short name (`relay-1`), never an address. */
          readonly name: 'ptbk_monitor_relay_checks_total';
          readonly relay: string;
          readonly outcome: 'up' | 'tls' | 'healthz' | 'metrics' | 'timeout';
      }
    | {
          /** The kept relay series of one scrape, in the order of `RELAY_HEALTH_SERIES` or `RELAY_OUTCOME_SERIES`. */
          readonly name: 'ptbk_monitor_relay_health' | 'ptbk_monitor_relay_outcomes';
          readonly relay: string;
          readonly values: readonly number[];
      }
    | { readonly name: 'ptbk_monitor_dashboard_checks_total'; readonly healthy: boolean };

export type DashboardMetricName = DashboardMetric['name'];

/**
 * Where the dashboard writes its counters (Workers Analytics Engine in production). Writing never throws or waits:
 * a lost data point must not fail a request.
 */
export interface DashboardMetrics {
    record(metric: DashboardMetric): void;
}

/** What the alert rules read back about the last window (spec: heartbeat rejections, email failures). */
export interface DashboardCounts {
    readonly heartbeatsAccepted: number;
    readonly heartbeatsRejected: number;
    readonly emailsSent: number;
    readonly emailsFailed: number;
}

export interface MetricsQuery {
    /** Totals over the last `minutes`; rejects when the store cannot answer, and the rules then skip these signals. */
    dashboardCounts(minutes: number, signal: AbortSignal): Promise<DashboardCounts>;
}
