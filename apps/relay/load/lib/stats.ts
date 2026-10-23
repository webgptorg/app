export interface Percentiles {
    readonly count: number;
    readonly min: number;
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
    readonly max: number;
    readonly mean: number;
}

const EMPTY: Percentiles = Object.freeze({ count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 });

/** Nearest-rank percentiles. */
export function percentiles(values: readonly number[]): Percentiles {
    if (values.length === 0) return EMPTY;
    const sorted = Float64Array.from(values).sort();
    const rank = (p: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
    let sum = 0;
    for (const value of sorted) sum += value;
    return {
        count: sorted.length,
        min: sorted[0] ?? 0,
        p50: rank(0.5),
        p95: rank(0.95),
        p99: rank(0.99),
        max: sorted[sorted.length - 1] ?? 0,
        mean: sum / sorted.length,
    };
}

export function median(values: readonly number[]): number {
    return percentiles(values).p50;
}
