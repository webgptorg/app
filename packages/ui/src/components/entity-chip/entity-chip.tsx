import type { CSSProperties, MouseEvent, ReactNode } from 'react';

import { cx } from '../../internal/cx';
import { tintStyle } from '../../theme/tint';
import { useHovercard } from '../hovercard/hovercard';
import type { HovercardState, HovercardTriggerProps } from '../hovercard/hovercard';
import { StatusDot } from '../status/status';
import type { StatusTone } from '../status/status';

/** `agent`: label in the tint. `neutral`: label in the text colour, tint only in the wash (tasks, runs, files…). */
export type EntityChipTone = 'agent' | 'neutral';

/** What `render` spreads onto its element, e.g. a router `Link`, so the chip can be a link without this package knowing the router. */
export interface EntityChipTriggerProps extends Partial<HovercardTriggerProps> {
    readonly className: string;
    readonly style: CSSProperties | undefined;
    readonly children: ReactNode;
}

export interface EntityChipProps {
    /** The entity's name; rendered as a text node only. */
    readonly label: string;
    /** A small type icon (lucide, `size-3.5`) or an `<Avatar size="2xs">`. Decorative. */
    readonly leading?: ReactNode;
    /** A colour token (`var(--color-agent-3)`, `var(--color-danger)`) or a `#rrggbb`; anything else is ignored. */
    readonly tint?: string | null;
    readonly tone?: EntityChipTone;
    /** A status dot after the label. */
    readonly status?: StatusTone;
    /** The status in words for screen readers (the dot alone is never the only signal). */
    readonly statusLabel?: string;
    /** In running text the chip wraps with it; elsewhere (cells, lists) it stays on one line and truncates. */
    readonly wrap?: boolean;
    /** The hovercard: its accessible name and its body, rendered only while open. Needs an interactive chip. */
    readonly hovercard?: { readonly label: string; readonly content: ReactNode };
    /**
     * Makes the chip a button. Without `onClick` and `render`, a chip with a hovercard toggles it on click (a tap has
     * no hover); a chip without one is plain text.
     */
    readonly onClick?: (event: MouseEvent<HTMLButtonElement>, hovercard: HovercardState) => void;
    /** Makes the chip any element, usually a link to the entity: spread the props onto it. */
    readonly render?: (props: EntityChipTriggerProps) => ReactNode;
    /** `false` inside another card: a quiet chip with no hovercard and no action. */
    readonly interactive?: boolean;
    readonly className?: string;
}

const BASE = 'rounded-(--entity-chip-radius) px-1 py-px font-medium';
const LAYOUT = {
    wrap: 'inline [box-decoration-break:clone] [overflow-wrap:anywhere]',
    line: 'inline-flex max-w-full min-w-0 items-center gap-1 align-middle whitespace-nowrap',
} as const;
const TONE_CLASSES: Readonly<Record<EntityChipTone, { readonly rest: string; readonly hover: string }>> = {
    agent: {
        rest: 'bg-[color-mix(in_oklab,var(--tint)_var(--entity-chip-wash),transparent)] text-tint',
        hover: 'hover:bg-[color-mix(in_oklab,var(--tint)_var(--entity-chip-wash-hover),transparent)]',
    },
    neutral: {
        rest: 'bg-[color-mix(in_oklab,var(--tint)_var(--entity-chip-neutral-wash),var(--entity-chip-neutral-base))] text-(--entity-chip-text)',
        hover: 'hover:bg-[color-mix(in_oklab,var(--tint)_var(--entity-chip-neutral-wash-hover),var(--entity-chip-neutral-base))]',
    },
};
const INTERACTIVE =
    'cursor-pointer text-start no-underline motion-safe:transition-[background-color] motion-safe:duration-(--motion-state) motion-safe:ease-standard';

/**
 * An agent, task, run, chat, file, trigger, integration or member as a chip: an icon or avatar, the name, an optional
 * status dot. Hovering or focusing it opens its hovercard (the same one everywhere); clicking opens the entity. The
 * entity-specific chips in the apps compose this core.
 */
export function EntityChip({
    label,
    leading,
    tint,
    tone = 'neutral',
    status,
    statusLabel,
    wrap = false,
    hovercard,
    onClick,
    render,
    interactive = true,
    className,
}: EntityChipProps) {
    const card = useHovercard({ label: hovercard?.label ?? label, content: hovercard?.content ?? null });
    const hasCard = hovercard !== undefined && interactive;
    const acts = interactive && (render !== undefined || onClick !== undefined || hasCard);
    const classes = cx(
        BASE,
        wrap ? LAYOUT.wrap : LAYOUT.line,
        '[--tint:var(--entity-chip-fallback-tint)]',
        TONE_CLASSES[tone].rest,
        acts && INTERACTIVE,
        acts && TONE_CLASSES[tone].hover,
        className,
    );
    const style = tintStyle(tint);
    const content = (
        <>
            {leading === undefined ? null : (
                <span
                    aria-hidden="true"
                    className={cx(
                        'inline-flex shrink-0 items-center text-(--entity-chip-icon) [&>svg]:size-3.5',
                        wrap && 'me-1 align-[-0.15em]',
                    )}
                >
                    {leading}
                </span>
            )}
            <span className={wrap ? undefined : 'min-w-0 truncate'}>{label}</span>
            {status === undefined ? null : (
                <StatusDot tone={status} className={cx('size-1.5', wrap && 'ms-1 align-middle')} />
            )}
            {status !== undefined && statusLabel !== undefined ? (
                <span className="sr-only">{`, ${statusLabel}`}</span>
            ) : null}
        </>
    );
    if (!acts) {
        return (
            <span className={classes} style={style}>
                {content}
            </span>
        );
    }
    const triggerProps = hasCard ? card.triggerProps : {};
    if (render !== undefined) {
        return (
            <>
                {render({ ...triggerProps, className: classes, style, children: content })}
                {hasCard ? card.card : null}
            </>
        );
    }
    return (
        <>
            <button
                type="button"
                {...triggerProps}
                className={classes}
                style={style}
                onClick={(event) => {
                    if (onClick !== undefined) onClick(event, card);
                    else if (card.open) card.hide();
                    else card.show(event.currentTarget);
                }}
            >
                {content}
            </button>
            {hasCard ? card.card : null}
        </>
    );
}
