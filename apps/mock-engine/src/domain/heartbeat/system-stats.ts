import type { CpuLoad } from '@ptbk/protocol';

/** Raw machine figures; the heartbeat rounds the percentages to tens (C-03), so nothing finer leaves the engine. */
export interface SystemStatsSample {
    /** Used share of the data directory's file system, 0 to 100. */
    readonly diskPct: number;
    /** Used share of memory, 0 to 100. */
    readonly ramPct: number;
    readonly cpuLoad: CpuLoad;
}

export interface SystemStats {
    sample(): Promise<SystemStatsSample>;
}

/** The 1-minute load average per core, as a bucket: below 0.5 is `low`, below 1 `medium`, anything above `high`. */
export function cpuLoadBucket(loadPerCore: number): CpuLoad {
    if (loadPerCore < 0.5) return 'low';
    return loadPerCore < 1 ? 'medium' : 'high';
}

/** Clamps a measured share into 0–100, so a rounding error in the platform's numbers is never a heartbeat bug. */
export function percent(part: number, whole: number): number {
    if (!(whole > 0)) return 0;
    return Math.min(100, Math.max(0, (part / whole) * 100));
}
