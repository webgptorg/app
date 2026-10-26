import { useLocale } from '@ptbk/ui';

import { useBrowser } from '../../app/browser-context';
import { useNow } from '../../app/ticker';
import { m } from '../../paraglide/messages';

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A date and time as `Intl` shows it in `timeZone`; never shifted by hand. */
export function formatInZone(at: Date, timeZone: string, locale: string): string {
    const key = `${locale}\u0000${timeZone}`;
    let format = formatters.get(key);
    if (format === undefined) {
        format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone });
        if (formatters.size < 64) formatters.set(key, format);
    }
    return format.format(at);
}

export function useBrowserTimeZone(): string {
    return useBrowser().timeZone;
}

export interface FireTimeProps {
    readonly at: string | null;
    /** The schedule's own zone (a cron's), shown next to the reader's when they differ. */
    readonly zone?: string | undefined;
    /** Adds "in 12 minutes" from the app's shared clock. */
    readonly countdown?: boolean;
    readonly empty?: string;
}

/** A fire time in the reader's zone, with the schedule's zone beside it when that is another one. */
export function FireTime({ at, zone, countdown = false, empty }: FireTimeProps) {
    const locale = useLocale();
    const browserZone = useBrowserTimeZone();
    if (at === null) return <span className="text-text-muted">{empty ?? m.trigger_value_none()}</span>;
    const date = new Date(at);
    // The schedule's own zone goes on a line of its own when space is short, never mid-time.
    return (
        <span className="inline-flex flex-wrap gap-x-2">
            <time dateTime={at}>{formatInZone(date, browserZone, locale.locale)}</time>
            {/* Read and copied as one line; the flex layout drops the space. */}
            {zone === undefined || zone === browserZone ? null : ' '}
            {zone === undefined || zone === browserZone ? null : (
                <span className="text-text-muted">
                    {m.trigger_time_zone({ zoneTime: formatInZone(date, zone, locale.locale), timeZone: zone })}
                </span>
            )}
            {countdown ? <Countdown at={date} /> : null}
        </span>
    );
}

function Countdown({ at }: { readonly at: Date }) {
    const locale = useLocale();
    const now = useNow();
    return <span className="text-text-muted">{locale.formatRelativeTime(at, new Date(now))}</span>;
}
