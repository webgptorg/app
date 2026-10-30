import { Check } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode, Ref } from 'react';

import { cx } from '../../internal/cx';

export interface MenuItemEntry {
    readonly kind: 'item';
    readonly id: string;
    /** The accessible name; also the visible text unless `content` is given. */
    readonly label: string;
    readonly description?: string;
    readonly icon?: ReactNode;
    /** A richer body (e.g. a trust mark with a name and hostname); `label` stays the accessible name. */
    readonly content?: ReactNode;
    readonly onSelect: () => void;
    readonly disabled?: boolean;
    readonly tone?: 'default' | 'danger';
    /**
     * Makes the item one choice of a set (`menuitemradio`), e.g. a language or theme; `true` marks the chosen one with
     * `aria-checked` and a check mark.
     */
    readonly checked?: boolean;
    /**
     * `checkbox` makes a checked item an independent toggle (`menuitemcheckbox`), e.g. a column's visibility; the menu
     * then stays open so several can be toggled in a row.
     */
    readonly checkable?: 'radio' | 'checkbox';
}

export interface MenuLinkEntry {
    readonly kind: 'link';
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly icon?: ReactNode;
    readonly content?: ReactNode;
    readonly href: string;
    /** Marks the item `aria-current="page"`, e.g. the engine the user is on. */
    readonly current?: boolean;
}

export interface MenuSeparatorEntry {
    readonly kind: 'separator';
    readonly id: string;
}

/** Labels the items that follow it, up to the next heading or separator, as one group. */
export interface MenuHeadingEntry {
    readonly kind: 'heading';
    readonly id: string;
    readonly label: string;
}

export type MenuEntry = MenuItemEntry | MenuLinkEntry | MenuSeparatorEntry | MenuHeadingEntry;

/** Spread onto the element that opens the menu, normally a `<button>`. */
export interface MenuTriggerProps {
    readonly ref: Ref<HTMLButtonElement>;
    readonly id: string;
    readonly 'aria-haspopup': 'menu';
    readonly 'aria-expanded': boolean;
    readonly 'aria-controls': string;
    readonly onClick: () => void;
    readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export interface MenuProps {
    /** The menu's accessible name. */
    readonly label: string;
    readonly trigger: (props: MenuTriggerProps) => ReactNode;
    readonly items: readonly MenuEntry[];
    /** Which edge of the trigger the menu lines up with. */
    readonly align?: 'start' | 'end';
    /** At least as wide as the trigger, e.g. under a full-width sidebar button, so the two line up. */
    readonly matchTriggerWidth?: boolean;
}

type ActionEntry = MenuItemEntry | MenuLinkEntry;

interface IndexedEntry {
    readonly entry: ActionEntry;
    /** Position among all actionable items, for roving focus. */
    readonly index: number;
}

interface Section {
    readonly id: string;
    readonly heading: MenuHeadingEntry | undefined;
    readonly entries: IndexedEntry[];
    readonly separatorBefore: boolean;
}

function sectionsOf(items: readonly MenuEntry[]): Section[] {
    const sections: Section[] = [];
    let count = 0;
    let current: Section = { id: 'start', heading: undefined, entries: [], separatorBefore: false };
    const flush = () => {
        if (current.entries.length > 0 || current.heading !== undefined) sections.push(current);
    };
    for (const item of items) {
        switch (item.kind) {
            case 'separator':
                flush();
                current = { id: item.id, heading: undefined, entries: [], separatorBefore: true };
                break;
            case 'heading':
                flush();
                current = {
                    id: item.id,
                    heading: item,
                    entries: [],
                    separatorBefore: current.separatorBefore && current.entries.length === 0,
                };
                break;
            case 'item':
            case 'link':
                current.entries.push({ entry: item, index: count });
                count += 1;
                break;
        }
    }
    flush();
    return sections;
}

/** Distance between the trigger and the menu, and between the menu and the viewport edge, in CSS pixels. */
const GAP = 4;
const VIEWPORT_MARGIN = 8;

interface Position {
    readonly top: number;
    readonly left: number;
    readonly minWidth: number | undefined;
}

function placeMenu(
    trigger: DOMRect,
    menu: DOMRect,
    align: 'start' | 'end',
    rtl: boolean,
    matchTriggerWidth: boolean,
): Position {
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = window.innerHeight;
    const minWidth = matchTriggerWidth ? Math.min(trigger.width, viewportWidth - 2 * VIEWPORT_MARGIN) : undefined;
    const width = Math.max(menu.width, minWidth ?? 0);
    const alignLeft = (align === 'start') !== rtl;
    const preferredLeft = alignLeft ? trigger.left : trigger.right - width;
    const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN);
    const left = Math.min(Math.max(preferredLeft, VIEWPORT_MARGIN), maxLeft);
    const below = trigger.bottom + GAP;
    const above = trigger.top - GAP - menu.height;
    const top = below + menu.height > viewportHeight - VIEWPORT_MARGIN && above >= VIEWPORT_MARGIN ? above : below;
    return { top, left, minWidth };
}

/**
 * A menu of actions and links on the Popover API (top layer, no portal, no injected styles). Keyboard: arrows, Home
 * and End move between items, typing jumps to an item, Tab wraps inside, Esc closes and returns focus to the trigger.
 */
export function Menu({ label, trigger, items, align = 'start', matchTriggerWidth = false }: MenuProps) {
    const triggerId = useId();
    const menuId = useId();
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);
    const [position, setPosition] = useState<Position | null>(null);
    const pendingFocus = useRef<'first' | 'last' | null>(null);

    const sections = sectionsOf(items);
    const actions = sections.flatMap((section) => section.entries.map(({ entry }) => entry));

    const itemElements = (): HTMLElement[] => [
        ...(menuRef.current?.querySelectorAll<HTMLElement>('[data-menu-index]') ?? []),
    ];
    const focusIndex = (index: number) => {
        const element = itemElements()[index];
        if (element === undefined) return;
        setActiveIndex(index);
        element.focus();
    };

    const show = (focus: 'first' | 'last') => {
        const menuElement = menuRef.current;
        if (menuElement === null) return;
        pendingFocus.current = focus;
        menuElement.showPopover();
        setOpen(true);
    };

    const close = (returnFocus: boolean) => {
        menuRef.current?.hidePopover();
        setOpen(false);
        if (returnFocus) triggerRef.current?.focus();
    };

    useEffect(() => {
        const menuElement = menuRef.current;
        if (menuElement === null) return;
        // Light dismiss (a click outside) closes the popover without us; keep state in step.
        const onToggle = (event: Event) => {
            if ((event as Event & { newState?: string }).newState === 'closed') setOpen(false);
        };
        menuElement.addEventListener('toggle', onToggle);
        return () => {
            menuElement.removeEventListener('toggle', onToggle);
        };
    }, []);

    useLayoutEffect(() => {
        const menuElement = menuRef.current;
        const triggerElement = triggerRef.current;
        if (!open || menuElement === null || triggerElement === null) return;
        const reposition = () => {
            const rtl = getComputedStyle(triggerElement).direction === 'rtl';
            setPosition(
                placeMenu(
                    triggerElement.getBoundingClientRect(),
                    menuElement.getBoundingClientRect(),
                    align,
                    rtl,
                    matchTriggerWidth,
                ),
            );
        };
        reposition();
        const target = pendingFocus.current;
        pendingFocus.current = null;
        if (target !== null) {
            const elements = [...menuElement.querySelectorAll<HTMLElement>('[data-menu-index]')];
            const index = target === 'first' ? 0 : elements.length - 1;
            setActiveIndex(index);
            elements[index]?.focus();
        }
        window.addEventListener('resize', reposition);
        window.addEventListener('scroll', reposition, true);
        return () => {
            window.removeEventListener('resize', reposition);
            window.removeEventListener('scroll', reposition, true);
        };
    }, [open, align, matchTriggerWidth]);

    const triggerProps: MenuTriggerProps = {
        ref: triggerRef,
        id: triggerId,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': menuId,
        onClick: () => {
            if (open) close(false);
            else show('first');
        },
        onKeyDown: (event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                show(event.key === 'ArrowDown' ? 'first' : 'last');
            }
        },
    };

    const select = (entry: ActionEntry) => {
        if (entry.kind === 'item') {
            if (entry.disabled === true) return;
            if (entry.checkable !== 'checkbox') close(true);
            entry.onSelect();
            return;
        }
        close(false);
    };

    const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const count = actions.length;
        const move = (index: number) => {
            event.preventDefault();
            focusIndex(((index % count) + count) % count);
        };
        switch (event.key) {
            case 'ArrowDown':
                move(activeIndex + 1);
                return;
            case 'ArrowUp':
                move(activeIndex - 1);
                return;
            case 'Home':
                move(0);
                return;
            case 'End':
                move(count - 1);
                return;
            case 'Tab':
                move(activeIndex + (event.shiftKey ? -1 : 1));
                return;
            case 'Escape':
                event.preventDefault();
                event.stopPropagation();
                close(true);
                return;
            default:
                if (event.key.length === 1 && /\S/u.test(event.key) && !event.ctrlKey && !event.metaKey) {
                    const key = event.key.toLocaleLowerCase();
                    for (let step = 1; step <= count; step += 1) {
                        const index = (activeIndex + step) % count;
                        if (actions[index]?.label.toLocaleLowerCase().startsWith(key) === true) {
                            move(index);
                            return;
                        }
                    }
                }
        }
    };

    const style: CSSProperties | undefined =
        position === null
            ? undefined
            : {
                  top: `${String(position.top)}px`,
                  left: `${String(position.left)}px`,
                  minWidth: position.minWidth === undefined ? undefined : `${String(position.minWidth)}px`,
              };

    const renderEntry = ({ entry, index: itemIndex }: IndexedEntry) => {
        const body = (
            <>
                {entry.icon === undefined ? null : (
                    <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
                        {entry.icon}
                    </span>
                )}
                {entry.content ?? (
                    <span className="flex min-w-0 flex-col">
                        <span className="truncate">{entry.label}</span>
                        {entry.description === undefined ? null : (
                            <span className="truncate text-xs text-(--menu-muted)">{entry.description}</span>
                        )}
                    </span>
                )}
            </>
        );
        const common = {
            role: 'menuitem',
            tabIndex: itemIndex === activeIndex ? 0 : -1,
            'aria-label': entry.content === undefined ? undefined : entry.label,
            'data-menu-index': itemIndex,
            onFocus: () => {
                setActiveIndex(itemIndex);
            },
            className: cx(
                'flex w-full items-center gap-2 rounded-(--menu-item-radius) px-3 py-2 text-start text-sm outline-none',
                'focus-visible:bg-(--menu-item-active) hover:bg-(--menu-item-active)',
                'motion-safe:transition-colors motion-safe:duration-(--motion-state)',
            ),
        } as const;
        if (entry.kind === 'link') {
            return (
                <a
                    key={entry.id}
                    {...common}
                    href={entry.href}
                    aria-current={entry.current === true ? 'page' : undefined}
                    className={cx(common.className, entry.current === true && 'font-semibold')}
                    onClick={() => {
                        select(entry);
                    }}
                >
                    {body}
                </a>
            );
        }
        const checkable = entry.checked !== undefined;
        const role = !checkable ? 'menuitem' : entry.checkable === 'checkbox' ? 'menuitemcheckbox' : 'menuitemradio';
        return (
            <button
                key={entry.id}
                {...common}
                role={role}
                aria-checked={checkable ? entry.checked : undefined}
                type="button"
                aria-disabled={entry.disabled === true ? true : undefined}
                className={cx(
                    common.className,
                    entry.tone === 'danger' && 'text-(--menu-danger)',
                    entry.disabled === true && 'cursor-not-allowed opacity-50',
                )}
                onClick={() => {
                    select(entry);
                }}
            >
                {body}
                {entry.checked === true ? (
                    <Check aria-hidden="true" className="ms-auto size-4 shrink-0 text-(--menu-check)" />
                ) : null}
            </button>
        );
    };

    return (
        <>
            {trigger(triggerProps)}
            <div
                ref={menuRef}
                id={menuId}
                popover="auto"
                role="menu"
                aria-label={label}
                tabIndex={-1}
                onKeyDown={onMenuKeyDown}
                style={style}
                className={cx(
                    'fixed inset-auto m-0 max-h-[calc(100dvh-var(--spacing)*4)] max-w-[calc(100vw-var(--spacing)*4)] min-w-48 overflow-auto p-1',
                    'rounded-(--menu-radius) border border-(--menu-border) bg-(--menu-bg) text-(--menu-text) shadow-(--menu-shadow)',
                    'motion-safe:animate-[ptbk-menu-enter_var(--motion-enter)_var(--ease-enter)]',
                )}
            >
                {sections.map((section) => {
                    const headingId = `${menuId}-${section.id}`;
                    return (
                        <div
                            key={section.id}
                            role="group"
                            aria-labelledby={section.heading === undefined ? undefined : headingId}
                            className={cx(section.separatorBefore && 'mt-1 border-t border-(--menu-separator) pt-1')}
                        >
                            {section.heading === undefined ? null : (
                                <div
                                    id={headingId}
                                    role="presentation"
                                    className="px-3 pt-2 pb-1 text-xs font-medium text-(--menu-muted)"
                                >
                                    {section.heading.label}
                                </div>
                            )}
                            {section.entries.map(renderEntry)}
                        </div>
                    );
                })}
            </div>
        </>
    );
}
