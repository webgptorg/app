import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CpuLoad } from '@ptbk/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { createOsSystemStats } from './os-system-stats';

const dirs: string[] = [];
afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('createOsSystemStats', () => {
    it('samples the data directory, memory and load as percentages and a bucket', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'm06-stats-'));
        dirs.push(dir);
        const sample = await createOsSystemStats(dir).sample();
        for (const value of [sample.diskPct, sample.ramPct]) {
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(100);
        }
        expect(CpuLoad.options).toContain(sample.cpuLoad);
    });

    it('fails for a data directory that does not exist', async () => {
        await expect(createOsSystemStats(join(tmpdir(), 'm06-missing-dir-x')).sample()).rejects.toThrow();
    });
});
