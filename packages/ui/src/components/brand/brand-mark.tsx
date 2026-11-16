import { cx } from '../../internal/cx';
import { SYMBOL_PATHS, LOCKUP_SYMBOL_TRANSFORM, WORDMARK_PATHS } from './brand-paths';

/** The kit's minimum digital widths, in CSS pixels. */
export const BRAND_MARK_MIN_SIZE = 32;
export const BRAND_LOCKUP_MIN_WIDTH = 160;

const LOCKUP_WIDTH = 760;
const LOCKUP_HEIGHT = 164;
/** The symbol's height inside the lockup's viewBox: 128 units scaled by the kit's 1.2126. */
const LOCKUP_SYMBOL_HEIGHT = 155.2;

interface BrandArtworkProps {
    /** Names the mark "Promptbook" for assistive tech; `true` hides it where text next to it already says so. */
    readonly decorative?: boolean;
    readonly className?: string;
}

export interface BrandMarkProps extends BrandArtworkProps {
    /** Square edge in pixels, at least the kit's 32. */
    readonly size?: number;
}

export interface BrandLockupProps extends BrandArtworkProps {
    /** Width in pixels, at least the kit's 160; the height follows the artwork's aspect ratio. */
    readonly width?: number;
}

function labelProps(decorative: boolean) {
    return decorative ? ({ 'aria-hidden': true } as const) : ({ role: 'img', 'aria-label': 'Promptbook' } as const);
}

/**
 * The Promptbook symbol (the PB hexagon), drawn from the kit's paths: ink blue in light, the kit's white artwork in
 * dark. It keeps a quarter of its height clear on every side, and never shrinks below 32px.
 */
export function BrandMark({ size = BRAND_MARK_MIN_SIZE, decorative = false, className }: BrandMarkProps) {
    const edge = Math.max(size, BRAND_MARK_MIN_SIZE);
    return (
        <svg
            {...labelProps(decorative)}
            focusable="false"
            viewBox="0 0 128 128"
            width={edge}
            height={edge}
            style={{ margin: edge / 4 }}
            className={cx('shrink-0', className)}
        >
            {SYMBOL_PATHS}
        </svg>
    );
}

/** The complete lockup: symbol and the "promptbook" wordmark, at least 160px wide and with its clear space. */
export function BrandLockup({ width = BRAND_LOCKUP_MIN_WIDTH, decorative = false, className }: BrandLockupProps) {
    const lockupWidth = Math.max(width, BRAND_LOCKUP_MIN_WIDTH);
    const height = (lockupWidth * LOCKUP_HEIGHT) / LOCKUP_WIDTH;
    const symbolHeight = (height * LOCKUP_SYMBOL_HEIGHT) / LOCKUP_HEIGHT;
    return (
        <svg
            {...labelProps(decorative)}
            focusable="false"
            viewBox={`0 0 ${String(LOCKUP_WIDTH)} ${String(LOCKUP_HEIGHT)}`}
            width={lockupWidth}
            height={height}
            style={{ margin: symbolHeight / 4 }}
            className={cx('shrink-0', className)}
        >
            <g transform={LOCKUP_SYMBOL_TRANSFORM}>{SYMBOL_PATHS}</g>
            {WORDMARK_PATHS}
        </svg>
    );
}
