import type { Hostname } from '@ptbk/protocol';

import type { Clock } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { DeliveryResult } from './alert-outbox';
import type { AlertThresholds, RelayCheck } from './alert-rules';
import type { AlertSink } from './alert-sink';
import type { DashboardMetrics, MetricsQuery } from './dashboard-metrics';
import type { MonitorStore } from './monitor-store';
import type { RelayProber } from './relay-prober';
import { RELAY_HEALTH_SERIES, RELAY_OUTCOME_SERIES, parseRelaySample, seriesValues } from './relay-sample';

const SEND_TIMEOUT_MS = 10_000;

export interface MonitoredRelay {
    readonly relayId: Hostname;
    /** The label in metrics and alerts: the relay hostname's first label (`relay-1`). */
    readonly name: string;
}

export interface MonitoringJobDeps {
    readonly relays: readonly MonitoredRelay[];
    readonly prober: RelayProber;
    /** The dashboard's own `/v1/health`, answered by this Worker. */
    readonly dashboardHealthy: (signal: AbortSignal) => Promise<boolean>;
    readonly metrics: DashboardMetrics;
    readonly query: MetricsQuery;
    readonly store: Pick<MonitorStore, 'observe'>;
    readonly thresholds: AlertThresholds;
    readonly clock: Clock;
    readonly logger: Logger;
    /** Per relay, for its health check and scrape together. */
    readonly probeTimeoutMs: number;
}

/** What delivering the queued alerts needs; the dispatcher does it once per cron run, after every job. */
export interface AlertDeliveryDeps {
    readonly store: Pick<MonitorStore, 'pending' | 'settle'>;
    /** Null without an ops address: alerts are then only logged, which counts as delivered. */
    readonly alerts: AlertSink | null;
    readonly metrics: DashboardMetrics;
    readonly logger: Logger;
}

/**
 * Hands every queued alert to the sink and settles the queue: a failed send stays queued for the next run, up to
 * `MAX_DELIVERY_ATTEMPTS`, then is dropped. Every attempt and drop is counted and logged.
 */
export async function deliverAlerts(deps: AlertDeliveryDeps): Promise<void> {
    const results: DeliveryResult[] = [];
    for (const { id, alert, attempts } of await deps.store.pending()) {
        const fields = { rule: alert.rule, subject: alert.subject, state: alert.state, attempt: attempts + 1 };
        deps.logger.warn('ops.alert', fields);
        let delivered = true;
        if (deps.alerts !== null) {
            try {
                await deps.alerts.send(alert, AbortSignal.timeout(SEND_TIMEOUT_MS));
            } catch {
                delivered = false;
                deps.logger.error('ops.alert-failed', fields);
            }
        }
        deps.metrics.record({ name: 'ptbk_monitor_alert_deliveries_total', outcome: delivered ? 'sent' : 'failed' });
        results.push({ id, delivered });
    }
    if (results.length === 0) return;
    for (const { alert } of await deps.store.settle(results)) {
        deps.logger.error('ops.alert-dropped', { rule: alert.rule, subject: alert.subject, state: alert.state });
        deps.metrics.record({ name: 'ptbk_monitor_alert_deliveries_total', outcome: 'dropped' });
    }
}

async function checkRelay(relay: MonitoredRelay, deps: MonitoringJobDeps): Promise<RelayCheck> {
    const probe = await deps.prober
        .probe(relay.relayId, AbortSignal.timeout(deps.probeTimeoutMs))
        .catch(() => ({ kind: 'down', reason: 'tls' }) as const);
    deps.metrics.record({
        name: 'ptbk_monitor_relay_checks_total',
        relay: relay.name,
        outcome: probe.kind === 'up' ? 'up' : probe.reason,
    });
    if (probe.kind === 'down') return { relay: relay.name, kind: 'down', reason: probe.reason };
    const sample = parseRelaySample(probe.metrics);
    deps.metrics.record({
        name: 'ptbk_monitor_relay_health',
        relay: relay.name,
        values: seriesValues(sample, RELAY_HEALTH_SERIES),
    });
    deps.metrics.record({
        name: 'ptbk_monitor_relay_outcomes',
        relay: relay.name,
        values: seriesValues(sample, RELAY_OUTCOME_SERIES),
    });
    return { relay: relay.name, kind: 'up', sample };
}

/**
 * The monitoring job (I-04), once a minute: every relay's TLS handshake, `/healthz` and `/metrics`, the dashboard's
 * own health, the dashboard's counters for the last window; then the alert rules, whose alerts the store queues for
 * the dispatcher to deliver. A relay that is down is an observation, not a failure of the run; a broken store fails it.
 */
export async function runMonitoring(deps: MonitoringJobDeps, signal: AbortSignal): Promise<void> {
    const at = deps.clock.nowMs();
    const window = Math.max(deps.thresholds.heartbeatRejectionWindowMinutes, deps.thresholds.emailFailureWindowMinutes);
    const [relays, dashboardHealthy, counts] = await Promise.all([
        Promise.all(deps.relays.map((relay) => checkRelay(relay, deps))),
        deps.dashboardHealthy(signal).catch(() => false),
        deps.query.dashboardCounts(window, signal).catch(() => {
            deps.logger.warn('ops.counts-unavailable', {});
            return null;
        }),
    ]);
    deps.metrics.record({ name: 'ptbk_monitor_dashboard_checks_total', healthy: dashboardHealthy });
    await deps.store.observe({ at, relays, dashboardHealthy, counts });
}
