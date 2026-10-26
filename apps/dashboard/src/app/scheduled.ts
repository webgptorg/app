import { createCertSpotterSource } from '../adapters/abuse/certspotter-source';
import { createCrtShSource } from '../adapters/abuse/crtsh-source';
import { createFetchPublicFaceFetcher } from '../adapters/abuse/fetch-public-face-fetcher';
import { createDatabase } from '../adapters/db/client';
import { createD1CtStore } from '../adapters/db/d1-ct-store';
import { createD1PublicFaceStore } from '../adapters/db/d1-public-face-store';
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
import { JOB_TIMEOUT_MS, scheduledJobs, type AbuseJobDeps } from './scheduled-jobs';

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

/** Timeouts that keep a whole run inside {@link JOB_TIMEOUT_MS}: 30 engines, 6 at a time, 8 s each at worst. */
const CT_SOURCE_TIMEOUT_MS = 20_000;
const PUBLIC_FACE_TIMEOUT_MS = 8_000;
const PUBLIC_FACE_CONCURRENCY = 6;

function abuseDeps(env: Env, config: DashboardConfig, shared: { readonly logger: Logger }): AbuseJobDeps | null {
    if (config.monitoring === null) return null;
    const settings = config.abuseMonitoring;
    const db = createDatabase(env.DB);
    const monitor = createDurableObjectMonitorStore(env.OPS_MONITOR);
    const fetchFn = (input: string, init: RequestInit) => fetch(input, init);
    // Says who is asking and where to complain, on every request to CT services and to engines.
    const userAgent = `PromptbookAbuseMonitor/1 (+${config.dashboardOrigin}/abuse)`;
    const sources = settings.ctSources.map((name) =>
        name === 'crt.sh'
            ? createCrtShSource({ fetch: fetchFn, userAgent })
            : createCertSpotterSource({ fetch: fetchFn, userAgent, apiKey: settings.certSpotterApiKey }),
    );
    return {
        ctWatch: {
            engineDomain: config.engineDomain,
            sources,
            store: createD1CtStore(db),
            monitor,
            settings: {
                allowedIssuers: settings.allowedIssuers,
                issuanceSpike: settings.issuanceSpike,
                sourceTimeoutMs: CT_SOURCE_TIMEOUT_MS,
            },
            clock: systemClock,
            logger: shared.logger,
        },
        publicFace: {
            engineDomain: config.engineDomain,
            fetcher: createFetchPublicFaceFetcher({ fetch: fetchFn, userAgent }),
            store: createD1PublicFaceStore(db),
            monitor,
            settings: {
                fingerprints: new Set(settings.publicFace.fingerprints),
                perRun: settings.publicFace.perRun,
                concurrency: PUBLIC_FACE_CONCURRENCY,
                timeoutMs: PUBLIC_FACE_TIMEOUT_MS,
            },
            clock: systemClock,
            logger: shared.logger,
        },
        // No feed provider is chosen yet (plan, "Still needed"); its adapter goes here with a `createD1ActiveEngineDirectory`.
        abuseFeeds: null,
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
        email === null || opsEmail === undefined
            ? null
            : createEmailAlertSink({ email: email.email, recipients: { ops: opsEmail, abuse: config.abuseEmail } });
    const store = createDurableObjectMonitorStore(env.OPS_MONITOR);
    const jobs = scheduledJobs({
        monitoring: monitoringDeps(env, ctx, config, dev, { metrics, logger }),
        abuse: abuseDeps(env, config, { logger }),
    });
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
