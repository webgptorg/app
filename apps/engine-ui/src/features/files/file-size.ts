import type { Formatters } from '@ptbk/ui';

const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;

/**
 * "512 bytes", "1.5 kB", "25 MB": decimal units, as file managers show sizes. Bytes are spelled out, because
 * `Intl`'s short form is the unpluralised "58 byte" in English; the long form follows each language's plural rules
 * ("1 bajt", "2 bajty", "58 bajtů").
 */
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
        unitDisplay: unit === 0 ? 'long' : 'short',
        maximumFractionDigits: unit === 0 ? 0 : 1,
    });
}
