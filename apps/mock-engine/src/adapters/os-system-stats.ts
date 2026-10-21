import { statfs } from 'node:fs/promises';
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os';

import type { SystemStats } from '../domain/heartbeat/system-stats';
import { cpuLoadBucket, percent } from '../domain/heartbeat/system-stats';

/** The host's figures: the data directory's file system, memory, and the 1-minute load average per core. */
export function createOsSystemStats(dataDir: string): SystemStats {
    return {
        async sample() {
            const fs = await statfs(dataDir);
            const total = totalmem();
            const [loadOneMinute = 0] = loadavg();
            return {
                diskPct: percent(fs.blocks - fs.bfree, fs.blocks),
                ramPct: percent(total - freemem(), total),
                cpuLoad: cpuLoadBucket(loadOneMinute / Math.max(1, availableParallelism())),
            };
        },
    };
}
