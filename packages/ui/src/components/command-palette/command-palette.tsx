import { CornerDownLeft, Search } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { cx } from '../../internal/cx';
import { useModalDialog } from '../../internal/use-modal-dialog';
import { Spinner } from '../spinner/spinner';

export interface CommandPaletteItem {
    /** Unique across all groups. */
    readonly id: string;
    /** Plain text; rendered as text, so untrusted names are safe here. */
    readonly label: string;
    /** A second, quieter line of plain text (an agent's description, a run's agent). */
    readonly detail?: string | undefined;
    readonly icon?: ReactNode;
}

export interface CommandPaletteGroup<Item extends CommandPaletteItem = CommandPaletteItem> {
    readonly id: string;
    readonly label: string;
    readonly items: readonly Item[];
}

export interface CommandPaletteProps<Item extends CommandPaletteItem = CommandPaletteItem> {
    readonly open: boolean;
    /** Esc, a backdrop click, or after a selection when the owner chooses to; focus then returns to the opener. */
    readonly onClose: () => void;
    /** The dialog's accessible name. */
    readonly title: string;
    /** The search box's accessible name and placeholder. */
    readonly label: string;
    readonly query: string;
    readonly onQueryChange: (query: string) => void;
    /** Empty groups are left out. */
    readonly groups: readonly CommandPaletteGroup<Item>[];
    /** Enter or a click on an option. */
    readonly onSelect: (item: Item) => void;
    /** The option the keyboard or pointer is on, e.g. to preload where it leads. */
    readonly onActiveChange?: (item: Item) => void;
    /** Results are still coming (a search request in flight). */
    readonly loading?: boolean;
    /** Shown when no group has an item. */
    readonly emptyText: string;
    /** How many options are listed, for screen readers, e.g. "3 results". */
    readonly resultsText: (count: number) => string;
}

/**
 * A modal search over places and actions: a native `<dialog>` holding an ARIA 1.2 combobox whose listbox groups the
 * results. Focus stays in the search box; ↑ and ↓ move the active option (`aria-activedescendant`), Enter selects it,
 * Esc closes and focus returns to whatever opened the palette. The active option is marked by a visible icon as well
 * as by colour.
 */
export function CommandPalette<Item extends CommandPaletteItem>({
    open,
    onClose,
    title,
    label,
    query,
    onQueryChange,
    groups,
    onSelect,
    onActiveChange,
    loading = false,
    emptyText,
    resultsText,
}: CommandPaletteProps<Item>) {
    const inputRef = useRef<HTMLInputElement>(null);
    const dialogRef = useModalDialog({ open, onClose, initialFocusRef: inputRef });
    const baseId = useId();
    const visibleGroups = groups.filter((group) => group.items.length > 0);
    const items = visibleGroups.flatMap((group) => group.items);
    const [activeKey, setActiveKey] = useState<string | null>(null);
    const activeIndex = Math.max(
        0,
        items.findIndex((item) => item.id === activeKey),
    );
    const active = items[activeIndex];
    const optionId = (item: Item) => `${baseId}-option-${String(items.indexOf(item))}`;
    const listboxId = `${baseId}-listbox`;

    const activate = (item: Item | undefined) => {
        if (item === undefined) return;
        setActiveKey(item.id);
        onActiveChange?.(item);
        document.getElementById(optionId(item))?.scrollIntoView({ block: 'nearest' });
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (items.length === 0) return;
        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                activate(items[(activeIndex + 1) % items.length]);
                break;
            case 'ArrowUp':
                event.preventDefault();
                activate(items[(activeIndex - 1 + items.length) % items.length]);
                break;
            case 'Home':
                if (!event.ctrlKey) return;
                event.preventDefault();
                activate(items[0]);
                break;
            case 'End':
                if (!event.ctrlKey) return;
                event.preventDefault();
                activate(items.at(-1));
                break;
            case 'Enter':
                event.preventDefault();
                if (active !== undefined) onSelect(active);
                break;
        }
    };

    return (
        <dialog
            ref={dialogRef}
            data-ptbk-modal=""
            aria-label={title}
            className={cx(
                'mx-auto mt-[12dvh] mb-auto max-h-[76dvh] w-[calc(100%-var(--spacing)*8)] max-w-xl overflow-hidden p-0',
                'rounded-(--command-palette-radius) border border-(--command-palette-border) bg-(--command-palette-bg) text-(--command-palette-text) shadow-(--command-palette-shadow)',
                'motion-safe:animate-[ptbk-dialog-enter_var(--motion-enter)_var(--ease-enter)]',
            )}
        >
            {open ? (
                <div className="flex max-h-[76dvh] flex-col">
                    <div className="flex items-center gap-2 border-b border-(--command-palette-border) px-4">
                        <Search aria-hidden="true" className="size-4 shrink-0 text-(--command-palette-muted)" />
                        <input
                            ref={inputRef}
                            type="text"
                            role="combobox"
                            aria-label={label}
                            placeholder={label}
                            aria-expanded="true"
                            aria-controls={listboxId}
                            aria-autocomplete="list"
                            aria-activedescendant={active === undefined ? undefined : optionId(active)}
                            autoComplete="off"
                            spellCheck={false}
                            value={query}
                            onChange={(event) => {
                                setActiveKey(null);
                                onQueryChange(event.target.value);
                            }}
                            onKeyDown={onKeyDown}
                            className="min-h-12 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-(--command-palette-muted)"
                        />
                        {loading ? <Spinner size="sm" announce={false} /> : null}
                    </div>
                    <div
                        role="listbox"
                        id={listboxId}
                        aria-label={title}
                        className={cx('min-h-0 flex-1 overflow-y-auto', items.length > 0 && 'p-2')}
                    >
                        {visibleGroups.map((group) => {
                            const headingId = `${baseId}-group-${group.id}`;
                            return (
                                <div key={group.id} role="group" aria-labelledby={headingId} className="py-1">
                                    <div
                                        id={headingId}
                                        role="presentation"
                                        className="px-2 py-1 text-xs font-medium text-(--command-palette-muted)"
                                    >
                                        {group.label}
                                    </div>
                                    {group.items.map((item) => {
                                        const selected = item === active;
                                        return (
                                            // The keyboard drives options through the combobox's
                                            // aria-activedescendant, so an option needs no key handler of its own.
                                            // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                                            <div
                                                key={item.id}
                                                id={optionId(item)}
                                                role="option"
                                                tabIndex={-1}
                                                aria-selected={selected}
                                                onPointerMove={() => {
                                                    if (!selected) activate(item);
                                                }}
                                                onMouseDown={(event) => {
                                                    // Keeps focus in the search box, where the combobox lives.
                                                    event.preventDefault();
                                                }}
                                                onClick={() => {
                                                    onSelect(item);
                                                }}
                                                className={cx(
                                                    'flex min-h-11 cursor-pointer items-center gap-3 rounded-(--command-palette-option-radius) px-2 py-1.5',
                                                    selected && 'bg-(--command-palette-option-active-bg)',
                                                )}
                                            >
                                                {item.icon === undefined ? null : (
                                                    <span
                                                        aria-hidden="true"
                                                        className="flex size-5 shrink-0 items-center justify-center text-(--command-palette-muted)"
                                                    >
                                                        {item.icon}
                                                    </span>
                                                )}
                                                <span className="flex min-w-0 flex-1 flex-col">
                                                    <span className="truncate text-sm">{item.label}</span>
                                                    {item.detail === undefined ? null : (
                                                        <span className="truncate text-xs text-(--command-palette-muted)">
                                                            {item.detail}
                                                        </span>
                                                    )}
                                                </span>
                                                <CornerDownLeft
                                                    aria-hidden="true"
                                                    className={cx(
                                                        'size-4 shrink-0 text-(--command-palette-marker)',
                                                        !selected && 'invisible',
                                                    )}
                                                />
                                            </div>
                                        );
                                    })}
                                </div>
                            );
                        })}
                    </div>
                    {items.length === 0 && !loading ? (
                        <p className="px-4 pb-6 text-center text-sm text-(--command-palette-muted)">{emptyText}</p>
                    ) : null}
                    <p role="status" className="sr-only">
                        {loading ? '' : resultsText(items.length)}
                    </p>
                </div>
            ) : null}
        </dialog>
    );
}
