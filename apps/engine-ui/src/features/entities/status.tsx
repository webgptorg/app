import { cx } from '../../app/cx';

/**
 * How loud a state is, across entities: live work breathes, needs-you is amber, trouble is red, done is green, waiting
 * is blue and everything settled or unknown is quiet.
 */
export type EntityTone = 'live' | 'attention' | 'waiting' | 'trouble' | 'done' | 'quiet';

/** `--tint` per tone, for soft surfaces and pills. */
export const TONE_TINT: Readonly<Record<EntityTone, string>> = {
    live: '[--tint:var(--color-live)]',
    attention: '[--tint:var(--color-warning)]',
    waiting: '[--tint:var(--color-info)]',
    trouble: '[--tint:var(--color-danger)]',
    done: '[--tint:var(--color-success)]',
    quiet: '[--tint:var(--color-text-muted)]',
};

const DOT: Readonly<Record<EntityTone, string>> = {
    live: 'bg-live motion-safe:animate-breathe',
    attention: 'bg-warning',
    waiting: 'bg-info',
    trouble: 'bg-danger',
    done: 'bg-success',
    quiet: 'bg-text-muted',
};

/** The small dot; decorative, so words always go with it. */
export function ToneDot({ tone, className }: { readonly tone: EntityTone; readonly className?: string }) {
    return (
        <span aria-hidden="true" className={cx('inline-block size-2 shrink-0 rounded-full', DOT[tone], className)} />
    );
}

/**
 * A state in words with its dot on a faint wash of the state's colour. The text stays the text colour, so contrast
 * never depends on the tint, and colour is never the only signal.
 */
export function StatusPill({
    tone,
    label,
    className,
}: {
    readonly tone: EntityTone;
    readonly label: string;
    readonly className?: string;
}) {
    return (
        <span
            className={cx(
                'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-pill px-2 text-xs font-medium whitespace-nowrap text-text',
                'bg-[color-mix(in_oklab,var(--tint)_12%,transparent)]',
                TONE_TINT[tone],
                className,
            )}
        >
            <ToneDot tone={tone} />
            {label}
        </span>
    );
}
