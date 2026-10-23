import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DEFAULT_THRESHOLDS } from '../domain/monitoring/alert-rules';
import { EVERY_MINUTE, scheduledJobs } from './scheduled-jobs';

/** wrangler.jsonc without its `//` comments and trailing commas; strings are copied untouched. */
function parseJsonc(text: string): unknown {
    let out = '';
    for (let index = 0; index < text.length; index++) {
        const char = text[index] as string;
        if (char === '"') {
            const end = text.indexOf('"', index + 1);
            let close = end;
            while (text[close - 1] === '\\') close = text.indexOf('"', close + 1);
            out += text.slice(index, close + 1);
            index = close;
        } else if (char === '/' && text[index + 1] === '/') {
            index = text.indexOf('\n', index) - 1;
        } else {
            out += char;
        }
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const workerConfig = z.object({
    triggers: z.object({ crons: z.array(z.string()) }),
    analytics_engine_datasets: z.array(z.object({ binding: z.string(), dataset: z.string() })),
    durable_objects: z.object({ bindings: z.array(z.object({ name: z.string(), class_name: z.string() })) }),
});
const wranglerSchema = workerConfig.extend({ env: z.record(z.string(), workerConfig) });

describe('Cron Triggers and scheduled jobs (I-04)', () => {
    it('agree in every environment, with the monitor object and the metrics dataset bound', () => {
        const wrangler = wranglerSchema.parse(
            parseJsonc(readFileSync(new URL('../../wrangler.jsonc', import.meta.url).pathname, 'utf8')),
        );
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
        });
        const crons = [...new Set(jobs.map((job) => job.cron))].sort();
        expect(crons).toEqual([EVERY_MINUTE]);
        expect(scheduledJobs({ monitoring: null })).toEqual([]);
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
