import { createFetchRelayProber } from '../adapters/monitoring/fetch-relay-prober';
import { createAnalyticsEngineQuery } from '../adapters/monitoring/analytics-engine-query';
import { createDurableObjectMonitorStore } from '../adapters/monitoring/durable-object-monitor-store';
import { createEmailAlertSink } from '../adapters/monitoring/email-alert-sink';
import { createConsoleLogger } from '../adapters/console-logger';
import { systemClock } from '../adapters/system-clock';
import { systemTimer } from '../adapters/system-timer';
import type { DashboardMetrics, MetricsQuery } from '../domain/monitoring/dashboard-metrics';
import type { MonitoringJobDeps } from '../domain/monitoring/monitoring-job';
import { deliverAlerts } from '../domain/monitoring/monitoring-job';
import { createScheduledDispatcher } from '../domain/scheduled/scheduled-dispatcher';
import type { Logger } from '../domain/ports/logger';
import { ConfigError, parseConfig, type DashboardConfig } from './config';
import { createDashboard, dashboardMetrics, emailSender } from './create-dashboard';
import type { DevAdapters } from './dev-adapters';
import { JOB_TIMEOUT_MS, scheduledJobs } from './scheduled-jobs';

function metricsQuery(config: DashboardConfig, dev: DevAdapters): MetricsQuery {
    const analytics = config.monitoring?.analytics ?? null;
    if (config.environment === 'dev' || analytics === null) return dev.metrics;
    return createAnalyticsEngineQuery({ ...analytics, fetch: (input, init) => fetch(input, init) });
}

function monitoringDeps(
    env: Env,
    ctx: ExecutionContext,
    config: DashboardConfig,
    dev: DevAdapters,
    shared: {
        readonly metrics: DashboardMetrics;
        readonly logger: Logger;
    },
): MonitoringJobDeps | null {
    const { monitoring } = config;
    if (monitoring === null) return null;
    const app = createDashboard(env, { viteDevServer: false, devAdapters: dev });
    return {
        relays: monitoring.relays,
        prober: createFetchRelayProber({
            fetch: (input, init) => fetch(input, init),
            tokens: new Map(monitoring.relays.map((relay) => [relay.relayId, relay.metricsToken])),
        }),
        // In-process: the route, its config and its rate limit, as a request would meet them. Whether the edge reaches
        // the Worker at all is the external uptime check's question (docs/runbooks/observability.md).
        dashboardHealthy: async (signal) => {
            const response = await app.fetch(new Request(`${config.dashboardOrigin}/v1/health`, { signal }), env, ctx);
            return response.ok;
        },
        query: metricsQuery(config, dev),
        store: createDurableObjectMonitorStore(env.OPS_MONITOR),
        thresholds: monitoring.thresholds,
        clock: systemClock,
        probeTimeoutMs: monitoring.probeTimeoutMs,
        ...shared,
    };
}

/** A cron run that cannot do its job must fail visibly, so Cloudflare's Cron Trigger log shows it as failed. */
export class ScheduledConfigError extends Error {
    constructor(problem: string) {
        super(`scheduled run refused: ${problem}`);
        this.name = 'ScheduledConfigError';
    }
}

/**
 * The Worker's one `scheduled` handler: dispatches the cron expression that fired to the jobs registered for it, then
 * delivers the queued alerts. Outside dev a configuration that would leave monitoring off (invalid config, no
 * `MONITORING`, no email binding) or a cron no job is registered for fails the run instead of passing quietly.
 */
export async function runScheduled(
    controller: Pick<ScheduledController, 'cron' | 'scheduledTime'>,
    env: Env,
    ctx: ExecutionContext,
    dev: DevAdapters,
): Promise<void> {
    let config: DashboardConfig;
    try {
        config = parseConfig(env);
    } catch (error) {
        if (error instanceof ConfigError) {
            createConsoleLogger({ service: 'dashboard' }).error('config.invalid', { paths: error.paths.join(',') });
        }
        throw error;
    }
    const logger = createConsoleLogger({ service: 'dashboard', environment: config.environment });
    const strict = config.environment !== 'dev';
    const refuse = (problem: string): never => {
        logger.error('cron.refused', { problem });
        throw new ScheduledConfigError(problem);
    };
    const metrics = dashboardMetrics(env, config, dev);
    const email = emailSender(env, config, dev, metrics);
    if (strict && config.monitoring === null) refuse('MONITORING is not set');
    if (strict && email === null) refuse('the email binding is missing');
    const opsEmail = config.monitoring?.opsEmail;
    const alerts =
        email === null || opsEmail === undefined ? null : createEmailAlertSink({ email: email.email, to: opsEmail });
    const store = createDurableObjectMonitorStore(env.OPS_MONITOR);
    const jobs = scheduledJobs({ monitoring: monitoringDeps(env, ctx, config, dev, { metrics, logger }) });
    const dispatcher = createScheduledDispatcher({
        jobs,
        clock: systemClock,
        timer: systemTimer,
        logger,
        metrics,
        recordRun: (run) => store.recordJobRun(run),
        deliver: () => deliverAlerts({ store, alerts, metrics, logger }),
        jobTimeoutMs: JOB_TIMEOUT_MS,
    });
    const results = await dispatcher.dispatch(controller.cron, controller.scheduledTime);
    if (strict && results.length === 0) refuse(`no job is registered for ${controller.cron}`);
}
