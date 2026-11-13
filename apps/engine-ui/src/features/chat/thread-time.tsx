import { useLocale } from '@ptbk/ui';

import { useBrowser } from '../../app/browser-context';
import { useNow } from '../../app/ticker';
import { m } from '../../paraglide/messages';
import { calendarDay } from './message-views';

const formats = new Map<string, Intl.DateTimeFormat>();

function format(locale: string, timeZone: string, kind: string, options: Intl.DateTimeFormatOptions) {
    const key = `${locale}\u0000${timeZone}\u0000${kind}`;
    let formatter = formats.get(key);
    if (formatter === undefined) {
        formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone });
        if (formats.size < 64) formats.set(key, formatter);
    }
    return formatter;
}

/** `12:16` in the reader's zone and language. */
export function useShortTime(at: string): string {
    const { locale } = useLocale();
    const { timeZone } = useBrowser();
    return format(locale, timeZone, 'short', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
        new Date(at),
    );
}

/** A turn's time, `12:16` in mono, with the exact moment on hover. */
export function TurnTime({ at }: { readonly at: string }) {
    const { locale } = useLocale();
    const { timeZone } = useBrowser();
    const exact = format(locale, timeZone, 'exact', {
        dateStyle: 'full',
        timeStyle: 'medium',
        hourCycle: 'h23',
    }).format(new Date(at));
    const short = useShortTime(at);
    return (
        <time dateTime={at} title={exact} className="text-xs font-normal text-text-muted tabular-nums">
            {short}
        </time>
    );
}

const DAY_MS = 86_400_000;

/** "Today", "Yesterday", "12 Nov", or "12 Nov 2025" for another year, in the reader's zone and language. */
export function DayDivider({ at }: { readonly at: string }) {
    const { locale } = useLocale();
    const { timeZone } = useBrowser();
    const now = new Date(useNow()).toISOString();
    const day = calendarDay(at, timeZone);
    const today = calendarDay(now, timeZone);
    const date = new Date(at);
    let label: string;
    if (day === today) label = m.chat_day_today();
    else if (day === calendarDay(new Date(Date.parse(now) - DAY_MS).toISOString(), timeZone)) {
        label = m.chat_day_yesterday();
    } else {
        const sameYear = day.slice(0, 4) === today.slice(0, 4);
        label = format(locale, timeZone, sameYear ? 'day' : 'day-year', {
            day: 'numeric',
            month: 'short',
            ...(sameYear ? {} : { year: 'numeric' }),
        }).format(date);
    }
    return (
        <div role="separator" aria-label={label} className="flex items-center gap-3 pt-6 pb-1">
            <span aria-hidden="true" className="h-px flex-1 bg-divider" />
            <time dateTime={day} aria-hidden="true" className="text-xs font-medium text-text-muted">
                {label}
            </time>
            <span aria-hidden="true" className="h-px flex-1 bg-divider" />
        </div>
    );
}
