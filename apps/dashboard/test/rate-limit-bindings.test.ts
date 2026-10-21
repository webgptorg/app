import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { RATE_LIMITS } from '../src/domain/ports/rate-limiter.ts';

const builtConfigSchema = z.object({
    ratelimits: z.array(z.object({ name: z.string(), simple: z.object({ limit: z.number(), period: z.number() }) })),
});

const BINDINGS = {
    RATE_LIMIT_OPTIONS: 'options-ip',
    RATE_LIMIT_VERIFY: 'verify-ip',
    RATE_LIMIT_PUBLIC_READ: 'public-read-ip',
    RATE_LIMIT_WEBHOOK: 'webhook-ip',
} as const;

// Runs after `build`: the binding's limit lives in wrangler.jsonc, the rule in code; they must not drift apart.
describe('Workers Rate Limiting bindings', () => {
    it('match the per-minute rules they serve', async () => {
        const config = builtConfigSchema.parse(
            JSON.parse(await readFile(new URL('../dist/ptbk_dashboard/wrangler.json', import.meta.url), 'utf8')),
        );
        expect(config.ratelimits.map((binding) => binding.name).sort()).toEqual(Object.keys(BINDINGS).sort());
        for (const binding of config.ratelimits) {
            const rule = RATE_LIMITS[BINDINGS[binding.name as keyof typeof BINDINGS]];
            expect(binding.simple, binding.name).toEqual({ limit: rule.limit, period: rule.windowMs / 1000 });
        }
    });
});
