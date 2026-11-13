import { cx } from '../../internal/cx';
import { tintStyle } from '../../theme/tint';

export type AvatarSize = '2xs' | 'xs' | 'sm' | 'md' | 'lg';

export interface AvatarProps {
    /** Whose avatar it is; only its first letter is drawn, and only when there is no picture. */
    readonly name: string;
    /**
     * A picture URL the app has already checked as safe to load (engine-ui: `safeImageSource`); this package cannot
     * know the engine's rules for it.
     */
    readonly src?: string | null;
    /** The agent's colour (`var(--color-agent-<n>)` or a `#rrggbb` profile colour); anything else is ignored. */
    readonly tint?: string | null;
    readonly size?: AvatarSize;
    readonly className?: string;
}

const SIZE_CLASSES: Readonly<Record<AvatarSize, string>> = {
    '2xs': 'size-4 text-[0.5625rem]',
    xs: 'size-5 text-[0.625rem]',
    sm: 'size-6 text-2xs',
    md: 'size-8 text-xs',
    lg: 'size-14 text-xl',
};

/**
 * A person's or agent's round mark: their picture, or their initial on a wash of their colour, so the same agent looks
 * the same in lists, chips, headers and hovercards. Decorative: the name beside it is the label. The initial is CSS
 * generated content, so it never joins a link's or button's accessible name (WCAG 2.5.3).
 */
export function Avatar({ name, src, tint, size = 'sm', className }: AvatarProps) {
    const classes = cx(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-pill align-middle font-semibold select-none',
        SIZE_CLASSES[size],
        className,
    );
    if (src !== null && src !== undefined && src !== '') {
        return <img src={src} alt="" aria-hidden="true" className={cx(classes, 'bg-(--avatar-bg) object-cover')} />;
    }
    return (
        <span
            aria-hidden="true"
            data-initial={Array.from(name.trim())[0]?.toLocaleUpperCase() ?? ''}
            style={tintStyle(tint)}
            className={cx(
                classes,
                '[--tint:var(--avatar-fallback-tint)] bg-[color-mix(in_oklab,var(--tint)_var(--avatar-wash),var(--avatar-bg))] text-tint before:content-[attr(data-initial)]',
            )}
        />
    );
}
