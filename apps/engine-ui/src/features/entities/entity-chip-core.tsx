import { useHovercard } from '@ptbk/ui';
import { createLink } from '@tanstack/react-router';
import type { AnchorHTMLAttributes, FocusEvent, PointerEvent, ReactNode, Ref } from 'react';

import { cx } from '../../app/cx';
import { StatusDot } from '../chat/references/task-status';
import type { ChatTaskTone } from '../chat/references/task-status';

/** A state as a dot on the chip; the words go to assistive technology here and into the hovercard for everyone. */
export interface ChipStatus {
    readonly tone: ChatTaskTone;
    readonly label: string;
}

interface ChipLookProps {
    /** The entity's name. Engine or user data: rendered as a text node only. */
    readonly label: string;
    /** A type icon (`aria-hidden`) or the agent's avatar. */
    readonly leading: ReactNode;
    readonly status?: ChipStatus | undefined;
    /** System or engine work: the chip steps back. */
    readonly muted?: boolean | undefined;
}

const CHIP = cx(
    'inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-control px-1.5 align-middle text-sm font-medium',
    'bg-quiet-hover [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-text-muted',
);

function ChipBody({ label, leading, status, muted }: ChipLookProps) {
    return (
        <>
            {leading}
            <span className={cx('min-w-0 truncate', muted === true ? 'text-text-muted' : 'text-text')}>{label}</span>
            {status === undefined ? null : (
                <>
                    <StatusDot tone={status.tone} />
                    <span className="sr-only">{`, ${status.label}`}</span>
                </>
            )}
        </>
    );
}

/** A chip with nowhere to go: the entity is gone, unnamed by ID, or the member may not open it. */
export function StaticChip({ className, ...look }: ChipLookProps & { readonly className?: string | undefined }) {
    return (
        <span className={cx(CHIP, className)}>
            <ChipBody {...look} />
        </span>
    );
}

interface ChipAnchorProps extends AnchorHTMLAttributes<HTMLAnchorElement>, ChipLookProps {
    /** The hovercard's body, rendered only while it is open, so a query inside it runs on first hover. */
    readonly card?: ReactNode;
    readonly ref?: Ref<HTMLAnchorElement>;
}

/**
 * The chip as a router link: a click opens the entity, hovering or keyboard focus opens its card. The router's own
 * focus and pointer handlers (preloading on intent) run before the hovercard's.
 */
function ChipAnchor({ label, leading, status, muted, card, className, ...rest }: ChipAnchorProps) {
    const hovercard = useHovercard({ label, content: card ?? null });
    const trigger = hovercard.triggerProps;
    const withCard =
        card === undefined
            ? {}
            : {
                  'aria-haspopup': trigger['aria-haspopup'],
                  'aria-expanded': trigger['aria-expanded'],
                  'aria-controls': trigger['aria-controls'],
                  onPointerEnter: (event: PointerEvent<HTMLAnchorElement>) => {
                      rest.onPointerEnter?.(event);
                      trigger.onPointerEnter(event);
                  },
                  onPointerLeave: (event: PointerEvent<HTMLAnchorElement>) => {
                      rest.onPointerLeave?.(event);
                      trigger.onPointerLeave();
                  },
                  onFocus: (event: FocusEvent<HTMLAnchorElement>) => {
                      rest.onFocus?.(event);
                      trigger.onFocus(event);
                  },
                  onBlur: (event: FocusEvent<HTMLAnchorElement>) => {
                      rest.onBlur?.(event);
                      trigger.onBlur(event);
                  },
              };
    return (
        <>
            <a
                {...rest}
                {...withCard}
                className={cx(
                    CHIP,
                    'cursor-pointer hover:bg-quiet-selected',
                    'motion-safe:transition-colors motion-safe:duration-(--motion-state)',
                    className,
                )}
            >
                <ChipBody label={label} leading={leading} status={status} muted={muted} />
            </a>
            {hovercard.card}
        </>
    );
}

/** The chip core every entity chip wraps: typed route, look, and an optional hovercard. */
export const ChipLink = createLink(ChipAnchor);

/** The common frame of an entity's hovercard: what it is, then facts, then the one way in. */
export function EntityCard({
    leading,
    title,
    meta,
    children,
    action,
}: {
    readonly leading: ReactNode;
    readonly title: string;
    /** One quiet line under the title: its state or kind. */
    readonly meta?: ReactNode;
    readonly children?: ReactNode;
    readonly action?: ReactNode;
}) {
    return (
        <span className="flex w-72 max-w-full flex-col gap-2.5 text-sm">
            <span className="flex items-start gap-2.5">
                <span className="mt-0.5 flex shrink-0 [&_svg]:size-4 [&_svg]:text-text-muted">{leading}</span>
                <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium [overflow-wrap:anywhere]">{title}</span>
                    {meta === undefined ? null : (
                        <span className="flex flex-wrap items-center gap-x-2 text-xs text-text-muted">{meta}</span>
                    )}
                </span>
            </span>
            {children}
            {action === undefined ? null : <span className="flex flex-wrap gap-2">{action}</span>}
        </span>
    );
}
