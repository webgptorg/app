/** `Intl` formatters for one locale. Building them is expensive, so `createFormatters` caches per locale. */
export interface Formatters {
    readonly locale: string;
    /** A date, e.g. "20 Oct 2026". */
    formatDate(value: Date): string;
    /** A date and time, e.g. "20 Oct 2026, 14:05". */
    formatDateTime(value: Date): string;
    formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
    /**
     * Money from a decimal string (`"0.0042"`) and an ISO 4217 code, formatted exactly: the string never becomes a
     * float, and its own decimals are kept beyond the currency's usual ones (up to 12).
     */
    formatCurrency(amount: string, currency: string): string;
    /** "3 minutes ago", "in 2 days", "now", relative to `now`. */
    formatRelativeTime(value: Date, now: Date): string;
    /**
     * An elapsed time in the two largest units, rounded down: "45 s", "3 min 5 s", "2 h 7 min", "1 d 2 h". The unit
     * symbols read the same in every supported language; only the numbers are localised.
     */
    formatDuration(ms: number): string;
}

const RELATIVE_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
    ['year', 365 * 24 * 3600],
    ['month', 30 * 24 * 3600],
    ['week', 7 * 24 * 3600],
    ['day', 24 * 3600],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
];

const DURATION_UNITS: readonly (readonly [string, number])[] = [
    ['d', 86_400],
    ['h', 3600],
    ['min', 60],
    ['s', 1],
];

const cache = new Map<string, Formatters>();

export function createFormatters(locale: string): Formatters {
    const cached = cache.get(locale);
    if (cached !== undefined) return cached;

    const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
    const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
    const number = new Intl.NumberFormat(locale);
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

    const formatters: Formatters = {
        locale,
        formatDate: (value) => date.format(value),
        formatDateTime: (value) => dateTime.format(value),
        formatNumber: (value, options) =>
            options === undefined ? number.format(value) : new Intl.NumberFormat(locale, options).format(value),
        formatCurrency: (amount, currency) => {
            const decimals = /\.(\d+)$/.exec(amount)?.[1]?.length ?? 0;
            const usual = new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions()
                .maximumFractionDigits;
            const format = new Intl.NumberFormat(locale, {
                style: 'currency',
                currency,
                maximumFractionDigits: Math.min(12, Math.max(usual ?? 2, decimals)),
            });
            // Intl formats a numeric string as the exact decimal it spells (ES2023), with no detour through a double.
            return format.format(amount as Intl.StringNumericLiteral);
        },
        formatRelativeTime: (value, now) => {
            const seconds = Math.round((value.getTime() - now.getTime()) / 1000);
            const [unit, size] = RELATIVE_UNITS.find(([, unitSeconds]) => Math.abs(seconds) >= unitSeconds) ?? [
                'second',
                1,
            ];
            return relative.format(Math.round(seconds / size), unit);
        },
        formatDuration: (ms) => {
            const total = Math.max(0, Math.floor(ms / 1000));
            const amounts = DURATION_UNITS.map(([, size], index) => {
                const above = DURATION_UNITS[index - 1]?.[1];
                return Math.floor((above === undefined ? total : total % above) / size);
            });
            const largest = amounts.findIndex((amount) => amount > 0);
            const first = largest === -1 ? DURATION_UNITS.length - 1 : largest;
            return DURATION_UNITS.slice(first, first + 2)
                .map(([symbol], offset) => `${number.format(amounts[first + offset] ?? 0)} ${symbol}`)
                .join(' ');
        },
    };
    cache.set(locale, formatters);
    return formatters;
}
