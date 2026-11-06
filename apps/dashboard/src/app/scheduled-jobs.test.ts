import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Hostname } from '@ptbk/protocol';

import { DEFAULT_THRESHOLDS } from '../domain/monitoring/alert-rules';
import { createFakeAbuseFeed } from '../testing/fake-abuse-feed';
import { createFakePublicFaceFetcher } from '../testing/fake-public-face-fetcher';
import { createMemoryCtStore } from '../testing/memory-ct-store';
import { createMemoryPublicFaceStore } from '../testing/memory-public-face-store';
import { createMemoryMonitor } from '../testing/test-monitoring';
import { readWranglerConfig } from '../testing/wrangler-config';
import { EVERY_15_MINUTES, EVERY_MINUTE, scheduledJobs, type AbuseJobDeps } from './scheduled-jobs';

const clock = { nowMs: () => 0 };
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const engineDomain = Hostname.parse('engines.ptbk.test');

function abuse(withFeeds: boolean): AbuseJobDeps {
    const monitor = createMemoryMonitor();
    return {
        ctWatch: {
            engineDomain,
            sources: [],
            store: createMemoryCtStore(),
            monitor,
            settings: { allowedIssuers: [], issuanceSpike: { limit: 1, days: 1 }, sourceTimeoutMs: 1 },
            clock,
            logger,
        },
        publicFace: {
            engineDomain,
            fetcher: createFakePublicFaceFetcher(),
            store: createMemoryPublicFaceStore({ engines: () => [] }),
            monitor,
            settings: { fingerprints: new Set(), perRun: 1, concurrency: 1, timeoutMs: 1 },
            clock,
            logger,
        },
        abuseFeeds: withFeeds
            ? {
                  feeds: [createFakeAbuseFeed('test')],
                  engines: { list: () => Promise.resolve([]) },
                  monitor,
                  maxEngines: 1,
                  timeoutMs: 1,
                  clock,
                  logger,
              }
            : null,
    };
}

const workerConfig = z.object({
    triggers: z.object({ crons: z.array(z.string()) }),
    analytics_engine_datasets: z.array(z.object({ binding: z.string(), dataset: z.string() })),
    durable_objects: z.object({ bindings: z.array(z.object({ name: z.string(), class_name: z.string() })) }),
});
const wranglerSchema = workerConfig.extend({ env: z.record(z.string(), workerConfig) });

describe('Cron Triggers and scheduled jobs (I-04, I-05)', () => {
    it('agree in every environment, with the monitor object and the metrics dataset bound', async () => {
        const wrangler = wranglerSchema.parse(readWranglerConfig());
        const jobs = scheduledJobs({
            monitoring: {
                relays: [],
                prober: { probe: () => Promise.reject(new Error('unused')) },
                dashboardHealthy: () => Promise.resolve(true),
                metrics: { record: () => undefined },
                query: { dashboardCounts: () => Promise.reject(new Error('unused')) },
                store: { observe: () => Promise.resolve() },
                thresholds: DEFAULT_THRESHOLDS,
                clock: { nowMs: () => 0 },
                logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
                probeTimeoutMs: 1000,
            },
            abuse: abuse(true),
        });
        expect(jobs.map((job) => `${job.name} ${job.cron}`)).toEqual([
            `relay-monitor ${EVERY_MINUTE}`,
            `ct-watch ${EVERY_15_MINUTES}`,
            `public-face ${EVERY_15_MINUTES}`,
            `abuse-feeds ${EVERY_15_MINUTES}`,
        ]);
        const crons = [...new Set(jobs.map((job) => job.cron))].sort();
        expect(crons).toEqual([EVERY_MINUTE, EVERY_15_MINUTES]);
        expect(scheduledJobs({ monitoring: null, abuse: null })).toEqual([]);
        // Without a feed provider the 15-minute cron still has its jobs, so a run never finds none registered.
        expect(scheduledJobs({ monitoring: null, abuse: abuse(false) }).map((job) => job.name)).toEqual([
            'ct-watch',
            'public-face',
        ]);
        for (const job of jobs.slice(1)) await job.run({ scheduledTime: 0, signal: new AbortController().signal });
        for (const [name, config] of [['dev', wrangler] as const, ...Object.entries(wrangler.env)]) {
            expect([...config.triggers.crons].sort(), name).toEqual(crons);
            expect(
                config.analytics_engine_datasets.map((dataset) => dataset.binding),
                name,
            ).toEqual(['OPS_METRICS']);
            expect(config.durable_objects.bindings, name).toContainEqual({
                name: 'OPS_MONITOR',
                class_name: 'OpsMonitor',
            });
        }
    });
});
