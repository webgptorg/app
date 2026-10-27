import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MonitorState } from '../domain/monitoring/alert-rules';
import { createMonitorService } from '../domain/monitoring/monitor-store';
import { DEFAULT_THRESHOLDS } from '../domain/monitoring/alert-rules';
import { TEST_PLANS, syntheticStripeKey, syntheticWebhookSecret } from '../testing/billing-fixtures';
import { TEST_INSTALL_VARS } from '../testing/install-fixtures';
import { ConfigError, DEV_RATE_LIMIT_HMAC_KEY } from './config';
import { createDevAdapters } from './dev-adapters';
import { runScheduled, ScheduledConfigError } from './scheduled';

const TOKEN = `ptbk_mt_${'q'.repeat(43)}`;
const monitoredVars = {
    ENVIRONMENT: 'dev',
    DASHBOARD_ORIGIN: 'https://app.ptbk.test',
    ENGINE_DOMAIN: 'engines.ptbk.test',
    RELAYS: [{ relayId: 'relay-1.ptbk.test', region: 'local' }],
    ...TEST_INSTALL_VARS,
    ADAPTERS: { email: 'fake', billing: 'fake', rateLimit: 'memory' },
    EMAIL_FROM: 'no-reply@ptbk.test',
    ABUSE_EMAIL: 'abuse@ptbk.test',
    RATE_LIMIT_HMAC_KEY: DEV_RATE_LIMIT_HMAC_KEY,
    BILLING_PLANS: TEST_PLANS,
    MONITORING: { opsEmail: 'ops@ptbk.test' },
    RELAY_METRICS_TOKENS: JSON.stringify({ 'relay-1.ptbk.test': TOKEN }),
};

/** Bindings are runtime objects, never plain JSON, or config would read them as vars. */
function binding<T extends object>(members: T): T {
    return Object.assign<object, T>(Object.create(Map.prototype) as object, members);
}

/** The `OPS_MONITOR` namespace, as one in-memory monitor. */
function opsMonitor() {
    let state: MonitorState | null = null;
    const service = createMonitorService({
        storage: {
            load: () => Promise.resolve(state),
            save: (next) => {
                state = next;
                return Promise.resolve();
            },
        },
        thresholds: DEFAULT_THRESHOLDS,
    });
    return binding({ idFromName: (name: string) => name, get: () => service });
}

/** A fresh staging environment, with its own monitor. */
const staging = () => ({
    ...monitoredVars,
    ENVIRONMENT: 'staging',
    ADAPTERS: { email: 'cloudflare', billing: 'stripe', rateLimit: 'workers' },
    RATE_LIMIT_HMAC_KEY: 'c3RhZ2luZy1zZWNyZXQta2V5LWZvci1yYXRlLWxpbWl0cy0zMmI',
    STRIPE_SECRET_KEY: syntheticStripeKey(),
    STRIPE_WEBHOOK_SECRET: syntheticWebhookSecret(),
    ANALYTICS: { accountId: 'f'.repeat(32), dataset: 'ptbk_ops_staging' },
    ANALYTICS_API_TOKEN: 'T'.repeat(40),
    OPS_METRICS: binding({ writeDataPoint: () => undefined }),
    OPS_MONITOR: opsMonitor(),
    EMAIL: binding({ send: () => Promise.resolve() }),
});

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const controller = { cron: '* * * * *', scheduledTime: 0 };

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('runScheduled', () => {
    it('runs the monitoring job with the configured relays and emails ops once a relay is down twice', async () => {
        const requests: string[] = [];
        vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
            requests.push(`${url} ${JSON.stringify(init.headers)}`);
            return Promise.reject(new TypeError('connect failed'));
        });
        const dev = createDevAdapters();
        const env = { ...monitoredVars, DB: binding({}), OPS_MONITOR: opsMonitor() } as unknown as Env;
        await runScheduled(controller, env, ctx, dev);
        await runScheduled(controller, env, ctx, dev);
        expect(requests).toEqual(['https://relay-1.ptbk.test/healthz {}', 'https://relay-1.ptbk.test/healthz {}']);
        expect(dev.outbox.sentTo('ops@ptbk.test')).toMatchObject([
            { template: 'ops-alert', rule: 'relay-unreachable', subject: 'relay-1', state: 'firing' },
        ]);
        const names = dev.metrics.records.map((record) => record.metric.name);
        expect(names).toContain('ptbk_dashboard_cron_runs_total');
        expect(names).toContain('ptbk_dashboard_requests_total');
        expect(dev.metrics.records.map((record) => record.metric)).toContainEqual({
            name: 'ptbk_monitor_dashboard_checks_total',
            healthy: true,
        });
    });

    it('runs no job without MONITORING in dev, and refuses a configuration it cannot parse', async () => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const unmonitored = Object.fromEntries(Object.entries(monitoredVars).filter(([name]) => name !== 'MONITORING'));
        const dev = createDevAdapters();
        await runScheduled(controller, { ...unmonitored, OPS_MONITOR: opsMonitor() } as unknown as Env, ctx, dev);
        expect(fetch).not.toHaveBeenCalled();
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            await expect(
                runScheduled(controller, { ...unmonitored, ENVIRONMENT: 'qa' } as unknown as Env, ctx, dev),
            ).rejects.toThrow(ConfigError);
        } finally {
            errors.mockRestore();
        }
    });

    it('outside dev, fails the run when monitoring would be off or no job is registered for the cron', async () => {
        vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')));
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const unmonitored = Object.fromEntries(Object.entries(staging()).filter(([name]) => name !== 'MONITORING'));
            await expect(
                runScheduled(controller, unmonitored as unknown as Env, ctx, createDevAdapters()),
            ).rejects.toThrow('MONITORING is not set');
            const noEmail = Object.fromEntries(Object.entries(staging()).filter(([name]) => name !== 'EMAIL'));
            await expect(runScheduled(controller, noEmail as unknown as Env, ctx, createDevAdapters())).rejects.toThrow(
                'the email binding is missing',
            );
            await expect(
                runScheduled(
                    { ...controller, cron: '0 0 * * *' },
                    staging() as unknown as Env,
                    ctx,
                    createDevAdapters(),
                ),
            ).rejects.toThrow(ScheduledConfigError);
        } finally {
            errors.mockRestore();
        }
    });

    it('reads the counts from Analytics Engine outside dev and emails alerts through the email binding', async () => {
        const urls: string[] = [];
        vi.stubGlobal('fetch', (url: string) => {
            urls.push(url);
            return Promise.reject(new TypeError('offline'));
        });
        const sent: unknown[] = [];
        const env = { ...staging(), EMAIL: binding({ send: (message: unknown) => sent.push(message) }) };
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            await runScheduled(controller, env as unknown as Env, ctx, createDevAdapters());
            await runScheduled(controller, env as unknown as Env, ctx, createDevAdapters());
        } finally {
            errors.mockRestore();
        }
        expect(urls).toContain(`https://api.cloudflare.com/client/v4/accounts/${'f'.repeat(32)}/analytics_engine/sql`);
        // This bare environment has no rate-limit bindings, so the Worker's own health check fails too.
        expect((sent as { subject: string }[]).map((message) => message.subject).sort()).toEqual([
            '[ptbk ops] FIRING: dashboard-unhealthy (dashboard)',
            '[ptbk ops] FIRING: relay-unreachable (relay-1)',
        ]);
    });

    it('runs the abuse jobs on the 15-minute cron, each failing on its own without the database', async () => {
        const fetch = vi.fn(() => Promise.reject(new TypeError('offline')));
        vi.stubGlobal('fetch', fetch);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const env = { ...monitoredVars, DB: binding({}), OPS_MONITOR: opsMonitor() } as unknown as Env;
            await runScheduled({ cron: '*/15 * * * *', scheduledTime: 0 }, env, ctx, createDevAdapters());
            const failed = errors.mock.calls
                .map(([line]) => JSON.parse(String(line)) as { event: string; job?: string })
                .filter((entry) => entry.event === 'cron.job-failed')
                .map((entry) => entry.job)
                .sort();
            expect(failed).toEqual(['ct-watch', 'public-face']);
        } finally {
            errors.mockRestore();
        }
        expect(fetch).not.toHaveBeenCalled();
    });

    it('registers the Web Risk feed with its key, and warns outside dev while the key is missing (I-08)', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.reject(new TypeError('offline'))),
        );
        const lines: string[] = [];
        const capture = (line: unknown) => {
            lines.push(String(line));
        };
        const errors = vi.spyOn(console, 'error').mockImplementation(capture);
        const warnings = vi.spyOn(console, 'warn').mockImplementation(capture);
        try {
            const keyed = {
                ...monitoredVars,
                WEB_RISK_API_KEY: `AIza${'w'.repeat(35)}`,
                DB: binding({}),
                OPS_MONITOR: opsMonitor(),
            } as unknown as Env;
            await runScheduled({ cron: '*/15 * * * *', scheduledTime: 0 }, keyed, ctx, createDevAdapters());
            const env = { ...staging(), DB: binding({}) } as unknown as Env;
            await runScheduled({ cron: '*/15 * * * *', scheduledTime: 0 }, env, ctx, createDevAdapters());
        } finally {
            errors.mockRestore();
            warnings.mockRestore();
        }
        const entries = lines.map((line) => JSON.parse(line) as { event: string; job?: string });
        expect(entries.filter((entry) => entry.event === 'cron.job-failed').map((entry) => entry.job)).toContain(
            'abuse-feeds',
        );
        expect(entries.filter((entry) => entry.event === 'abuse-feed.unconfigured')).toHaveLength(1);
        expect(lines.join('\n')).not.toContain('AIza');
    });

    it('rethrows what is not a configuration error', async () => {
        await expect(runScheduled(controller, null as unknown as Env, ctx, createDevAdapters())).rejects.toThrow(
            TypeError,
        );
    });
});
