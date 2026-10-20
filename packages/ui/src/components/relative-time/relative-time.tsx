import { useLocale } from '../../i18n/ui-provider';

export interface RelativeTimeProps {
    readonly value: Date;
    /** The reference point; defaults to the time of rendering. */
    readonly now?: Date;
    readonly className?: string;
}

/** "3 minutes ago", with the exact time as a tooltip and a machine-readable `datetime`. */
export function RelativeTime({ value, now, className }: RelativeTimeProps) {
    const formatters = useLocale();
    return (
        <time dateTime={value.toISOString()} title={formatters.formatDateTime(value)} className={className}>
            {formatters.formatRelativeTime(value, now ?? new Date())}
        </time>
    );
}
