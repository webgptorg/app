import { CornerDownLeft } from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';

import { cx } from '../../internal/cx';
import { TINT_TEXT_RESET, tintStyle } from '../../theme/tint';
import { StatusPill } from '../status/status';
import type { StatusTone } from '../status/status';

export interface PeekCardFact {
    readonly label: string;
    /** Text, or a chip (an agent, a task). */
    readonly value: ReactNode;
}

/** What `PeekCardAction.render` spreads onto its element, usually a router link to the entity. */
export interface PeekCardActionProps {
    /** Marks the element Enter clicks. */
    readonly 'data-peek-card-action': '';
    readonly className: string;
    readonly 'aria-keyshortcuts': 'Enter';
    readonly children: ReactNode;
}

export interface PeekCardAction {
    /** "Open task", "Open agent". */
    readonly label: string;
    /** Makes the action any element, e.g. a router `Link`; spread the props onto it. */
    readonly render?: ((props: PeekCardActionProps) => ReactNode) | undefined;
    /** Makes the action a button. */
    readonly onSelect?: (() => void) | undefined;
}

export interface PeekCardProps {
    /** The entity's type in words: "Task", "Agent", "Run". */
    readonly kind: string;
    /** A type icon (lucide) or the agent's `<Avatar size="xs">`. Decorative. */
    readonly icon?: ReactNode | undefined;
    readonly status?: { readonly tone: StatusTone; readonly label: string } | undefined;
    /** The entity's name; text only. */
    readonly title: string;
    /** One or two quiet lines: a description, the latest step, a preview. */
    readonly description?: ReactNode | undefined;
    /** Two to four label → value rows. */
    readonly facts?: readonly PeekCardFact[] | undefined;
    /** Anything else worth a glance, between the facts and the footer (a live step). */
    readonly children?: ReactNode | undefined;
    /** The main action, behind a hairline with an ↵ hint: Enter anywhere in the card that is not a control does it. */
    readonly action?: PeekCardAction | undefined;
    /** Further quiet actions beside it, e.g. Mention. */
    readonly secondary?: ReactNode | undefined;
    /** The agent's or status's colour (`var(--color-…)` or `#rrggbb`) for the wash. */
    readonly tint?: string | null | undefined;
    /** A status's `--tint` class instead, e.g. `STATUS_TINT_CLASSES.danger`; it washes stronger in dark mode. */
    readonly tintClassName?: string | undefined;
    readonly className?: string | undefined;
}

const ACTION_CLASS =
    'inline-flex min-h-7 items-center gap-1 rounded-control px-2 -ms-2 text-xs font-medium text-(--peek-card-title) no-underline hover:bg-(--peek-card-action-hover) motion-safe:transition-colors motion-safe:duration-(--motion-state)';

const CONTROLS = 'a[href], button, input, select, textarea, [role="button"], [role="link"]';

/**
 * A Linear-style peek at an entity, for a `Hovercard` body: its type, status and name, a line about it, a few facts,
 * and the action that opens it. Every value is engine data and renders as text or as the chips the caller passes.
 */
export function PeekCard({
    kind,
    icon,
    status,
    title,
    description,
    facts,
    children,
    action,
    secondary,
    tint,
    tintClassName,
    className,
}: PeekCardProps) {
    const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
        if (event.key !== 'Enter' || action === undefined) return;
        if (event.target instanceof Element && event.target.closest(CONTROLS) !== null) return;
        event.preventDefault();
        event.currentTarget.querySelector<HTMLElement>('[data-peek-card-action]')?.click();
    };
    return (
        // The card is a group of text and controls; Enter is a shortcut for its main action, which stays reachable.
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions
        <span
            onKeyDown={onKeyDown}
            style={tintStyle(tint) ?? TINT_TEXT_RESET}
            className={cx(
                '-m-3 flex w-80 max-w-[calc(100vw-1rem)] flex-col rounded-(--hovercard-radius) text-sm',
                tintClassName === undefined
                    ? '[--tint:var(--peek-card-fallback-tint)] bg-[color-mix(in_oklab,var(--tint)_var(--peek-card-wash),transparent)]'
                    : cx(
                          tintClassName,
                          'bg-[color-mix(in_oklab,var(--tint)_var(--peek-card-status-wash),transparent)]',
                      ),
                className,
            )}
        >
            <span className="flex flex-col gap-2 p-3.5 pb-3">
                <span className="flex min-h-6 items-center gap-2">
                    {icon === undefined ? null : (
                        <span
                            aria-hidden="true"
                            className="inline-flex shrink-0 items-center text-(--peek-card-kind) [&>svg]:size-4"
                        >
                            {icon}
                        </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-xs text-(--peek-card-kind)">{kind}</span>
                    {status === undefined ? null : (
                        <StatusPill tone={status.tone} className="shrink-0">
                            {status.label}
                        </StatusPill>
                    )}
                </span>
                <span className="block text-base leading-snug font-semibold text-(--peek-card-title) [overflow-wrap:anywhere]">
                    {title}
                </span>
                {description === undefined || description === null ? null : (
                    <span className="line-clamp-2 block text-xs text-(--peek-card-muted)">{description}</span>
                )}
                {facts === undefined || facts.length === 0 ? null : (
                    // Spans, not a <dl>: the hovercard renders right after its trigger, often inside a paragraph.
                    <span className="mt-1 grid grid-cols-[minmax(4.5rem,auto)_1fr] items-center gap-x-4 gap-y-1.5 text-xs">
                        {facts.map((fact) => (
                            <span key={fact.label} className="contents">
                                <span className="text-(--peek-card-muted)">{fact.label}</span>
                                <span className="min-w-0 text-(--peek-card-title) tabular-nums">{fact.value}</span>
                            </span>
                        ))}
                    </span>
                )}
                {children}
            </span>
            {action === undefined && secondary === undefined ? null : (
                <span className="flex min-h-10 items-center gap-1 border-t border-(--peek-card-hairline) px-3.5 py-1.5">
                    {action === undefined ? null : action.render !== undefined ? (
                        action.render({
                            'data-peek-card-action': '',
                            className: ACTION_CLASS,
                            'aria-keyshortcuts': 'Enter',
                            children: action.label,
                        })
                    ) : (
                        <button
                            data-peek-card-action=""
                            type="button"
                            aria-keyshortcuts="Enter"
                            onClick={action.onSelect}
                            className={cx(ACTION_CLASS, 'cursor-pointer')}
                        >
                            {action.label}
                        </button>
                    )}
                    {secondary}
                    {action === undefined ? null : (
                        <kbd
                            aria-hidden="true"
                            className="ms-auto inline-flex size-5 items-center justify-center rounded-small bg-(--peek-card-key-bg) text-(--peek-card-muted)"
                        >
                            <CornerDownLeft className="size-3" />
                        </kbd>
                    )}
                </span>
            )}
        </span>
    );
}
