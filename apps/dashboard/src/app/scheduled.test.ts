import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MonitorState } from '../domain/monitoring/alert-rules';
import { createMonitorService } from '../domain/monitoring/monitor-store';
import { DEFAULT_THRESHOLDS } from '../domain/monitoring/alert-rules';
import { TEST_PLANS, syntheticStripeKey, syntheticWebhookSecret } from '../testing/billing-fixtures';
import { DEV_RATE_LIMIT_HMAC_KEY } from './config';
import { createDevAdapters } from './dev-adapters';
import { runScheduled } from './scheduled';

const TOKEN = `ptbk_mt_${'q'.repeat(43)}`;
const monitoredVars = {
    ENVIRONMENT: 'dev',
    DASHBOARD_ORIGIN: 'https://app.ptbk.test',
    ENGINE_DOMAIN: 'engines.ptbk.test',
    RELAYS: [{ relayId: 'relay-1.ptbk.test', region: 'local' }],
    INSTALL_COMMAND: 'bun run dev:link {linkCode}',
    ADAPTERS: { email: 'fake', billing: 'fake', rateLimit: 'memory' },
    EMAIL_FROM: 'no-reply@ptbk.test',
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

    it('runs no job without MONITORING, and nothing at all on a configuration it refuses', async () => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const unmonitored = Object.fromEntries(Object.entries(monitoredVars).filter(([name]) => name !== 'MONITORING'));
        const dev = createDevAdapters();
        await runScheduled(controller, { ...unmonitored, OPS_MONITOR: opsMonitor() } as unknown as Env, ctx, dev);
        await runScheduled(controller, { ...unmonitored, ENVIRONMENT: 'qa' } as unknown as Env, ctx, dev);
        expect(fetch).not.toHaveBeenCalled();
        expect(dev.metrics.records).toEqual([]);
    });

    it('reads the counts from Analytics Engine outside dev, and logs alerts when the email binding is missing', async () => {
        const urls: string[] = [];
        vi.stubGlobal('fetch', (url: string) => {
            urls.push(url);
            return Promise.reject(new TypeError('offline'));
        });
        const staging = {
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
        };
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            await runScheduled(controller, staging as unknown as Env, ctx, createDevAdapters());
        } finally {
            errors.mockRestore();
        }
        expect(urls).toContain(`https://api.cloudflare.com/client/v4/accounts/${'f'.repeat(32)}/analytics_engine/sql`);
    });

    it('rethrows what is not a configuration error', async () => {
        await expect(runScheduled(controller, null as unknown as Env, ctx, createDevAdapters())).rejects.toThrow(
            TypeError,
        );
    });
});
