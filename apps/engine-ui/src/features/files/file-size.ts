import type { Formatters } from '@ptbk/ui';

const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;

/** "512 B", "1.5 kB", "25 MB": decimal units, as file managers show sizes. */
export function formatBytes(formatters: Formatters, bytes: number): string {
    let value = bytes;
    let unit = 0;
    while (value >= 1000 && unit < UNITS.length - 1) {
        value /= 1000;
        unit += 1;
    }
    return formatters.formatNumber(value, {
        style: 'unit',
        unit: UNITS[unit],
        unitDisplay: 'short',
        maximumFractionDigits: unit === 0 ? 0 : 1,
    });
}
