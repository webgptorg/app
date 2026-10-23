import { readFileSync } from 'node:fs';

import { median } from './stats';

/** One row of relay-probe.mts's CSV. */
export type Sample = Readonly<Record<string, number>>;

export function readSamples(path: string): Sample[] {
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch {
        return [];
    }
    const [header = '', ...lines] = text.trim().split('\n');
    const columns = header.split(',');
    // The relay may restart mid-run (reconnect storm) and write the header again.
    return lines
        .filter((line) => line !== '' && !line.startsWith('time_ms'))
        .map((line) => {
            const values = line.split(',');
            return Object.fromEntries(columns.map((column, index) => [column, Number(values[index] ?? Number.NaN)]));
        });
}

export function within(samples: readonly Sample[], from: number, to: number): Sample[] {
    return samples.filter((sample) => (sample['time_ms'] ?? 0) >= from && (sample['time_ms'] ?? 0) <= to);
}

export function medianOf(samples: readonly Sample[], column: string): number {
    return median(samples.map((sample) => sample[column] ?? Number.NaN).filter((value) => Number.isFinite(value)));
}

export function maxOf(samples: readonly Sample[], column: string): number {
    return Math.max(...samples.map((sample) => sample[column] ?? Number.NaN).filter((value) => Number.isFinite(value)));
}

/** Per-interval rates of a counter column, per second; intervals across a restart (counter went down) are skipped. */
export function rates(samples: readonly Sample[], column: string): number[] {
    const result: number[] = [];
    for (let index = 1; index < samples.length; index++) {
        const previous = samples[index - 1];
        const current = samples[index];
        if (previous === undefined || current === undefined) continue;
        const delta = (current[column] ?? 0) - (previous[column] ?? 0);
        const seconds = ((current['time_ms'] ?? 0) - (previous['time_ms'] ?? 0)) / 1000;
        if (delta >= 0 && seconds > 0) result.push(delta / seconds);
    }
    return result;
}

/** Average rate of a counter column over the samples, per second. */
export function averageRate(samples: readonly Sample[], column: string): number {
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (first === undefined || last === undefined || first === last) return Number.NaN;
    const seconds = ((last['time_ms'] ?? 0) - (first['time_ms'] ?? 0)) / 1000;
    return ((last[column] ?? 0) - (first[column] ?? 0)) / seconds;
}

/** Relay CPU from the container's cgroup, in percent of one core (200 is both of the capped container's cores). */
export function cpuPercent(samples: readonly Sample[]): number {
    return averageRate(samples, 'cgroup_cpu_us') / 10_000;
}

export function peakCpuPercent(samples: readonly Sample[]): number {
    return Math.max(...rates(samples, 'cgroup_cpu_us').map((rate) => rate / 10_000));
}
