import { readdirSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/** Process health for `/metrics`; nothing here concerns engines or browsers. */
export interface ProcessStats {
    residentMemoryBytes(): number;
    heapUsedBytes(): number;
    /** `null` where the platform does not list them. */
    openFds(): number | null;
    /** The largest event loop delay since the previous call, in seconds. */
    takeEventLoopLagSeconds(): number;
    readonly startTimeSeconds: number;
    stop(): void;
}

const FD_DIRECTORIES = ['/proc/self/fd', '/dev/fd'];
const LAG_RESOLUTION_MS = 20;

function countOpenFds(): number | null {
    for (const directory of FD_DIRECTORIES) {
        try {
            // Reading the directory opens one descriptor of its own, which is listed too.
            return readdirSync(directory).length - 1;
        } catch {
            // Not on this platform: try the next.
        }
    }
    return null;
}

export function createProcessStats(): ProcessStats {
    const lag = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS });
    lag.enable();
    return {
        residentMemoryBytes: () => process.memoryUsage.rss(),
        heapUsedBytes: () => process.memoryUsage().heapUsed,
        openFds: countOpenFds,
        takeEventLoopLagSeconds() {
            // `max` is in nanoseconds, and 0 before the first sample.
            const seconds = lag.count === 0 ? 0 : lag.max / 1e9;
            lag.reset();
            return seconds;
        },
        startTimeSeconds: Math.round((Date.now() - process.uptime() * 1000) / 1000),
        stop() {
            lag.disable();
        },
    };
}
