import { ArrowDownWideNarrow, ArrowUpNarrowWide, Ellipsis, Plus, Search, X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, Ref } from 'react';

import { useLocale, useUiMessages } from '../../i18n/ui-provider';
import { cx } from '../../internal/cx';
import { useScrollEdges } from '../../internal/scroll-edges';
import { Button } from '../button/button';
import { IconButton } from '../icon-button/icon-button';
import { Menu } from '../menu/menu';
import type { MenuEntry } from '../menu/menu';
import { useAnchoredPopover } from './anchored-popover';
import { clearField, isFieldActive, selectedOptions } from './filter-fields';
import type { FilterBarDateRange, FilterBarField, FilterBarOption } from './filter-fields';
import { FilterPopover } from './filter-popover';
import type { FilterPopoverView } from './filter-popover';

export type {
    FilterBarDateRange,
    FilterBarDateRangeField,
    FilterBarEntityField,
    FilterBarEnumField,
    FilterBarField,
    FilterBarMultiEnumField,
    FilterBarOption,
} from './filter-fields';
export { filterField } from './filter-fields';

export interface FilterBarSearch {
    /** The accessible name, e.g. "Search agents"; also the placeholder unless `placeholder` is given. */
    readonly label: string;
    readonly value: string;
    readonly onChange: (value: string) => void;
    readonly placeholder?: string;
    readonly maxLength?: number;
    /** E.g. to focus the search from a keyboard shortcut. */
    readonly inputRef?: Ref<HTMLInputElement>;
}

export interface FilterBarSortOption {
    readonly id: string;
    readonly label: string;
}

export interface FilterBarSortValue {
    readonly id: string;
    readonly desc: boolean;
}

/** The list's order; `DataTable`'s toolbar hands one over that mirrors its sortable headers. */
export interface FilterBarSort {
    readonly options: readonly FilterBarSortOption[];
    readonly value: FilterBarSortValue | undefined;
    readonly onChange: (value: FilterBarSortValue) => void;
}

export interface FilterBarColumn {
    readonly id: string;
    readonly label: string;
    readonly visible: boolean;
    /** The last visible column cannot hide. */
    readonly disabled: boolean;
}

/** Which columns show; `DataTable`'s toolbar hands this over, and the bar offers it in its overflow menu. */
export interface FilterBarColumns {
    readonly items: readonly FilterBarColumn[];
    readonly onToggle: (id: string) => void;
}

export interface FilterBarProps {
    /** Names the search landmark; defaults to "Filters". */
    readonly label?: string;
    readonly search?: FilterBarSearch;
    /** What "+ Filter" offers, in this order. The consumer owns every value (bind them to the URL). */
    readonly fields?: readonly FilterBarField[];
    /**
     * Clears the search and every field at once. Give it when the state lives in one place (the URL), so clearing is
     * one change rather than one per field; without it, each field and the search are cleared in turn.
     */
    readonly onClear?: () => void;
    readonly sort?: FilterBarSort;
    readonly columns?: FilterBarColumns;
    /** The collection has nothing in it; the bar then renders nothing unless a search or filter is what emptied it. */
    readonly empty?: boolean;
}

/** How many values a chip names before it says "+2". */
const CHIP_VALUES = 2;

/** A fade where the bar hides chips on a narrow screen, so it never clips silently. */
const FADE_CLASSES = {
    left: '[mask-image:linear-gradient(to_left,#000_calc(100%-var(--filter-bar-fade)),transparent)]',
    right: '[mask-image:linear-gradient(to_right,#000_calc(100%-var(--filter-bar-fade)),transparent)]',
    both: '[mask-image:linear-gradient(to_right,transparent,#000_var(--filter-bar-fade),#000_calc(100%-var(--filter-bar-fade)),transparent)]',
} as const;

const CLOSED: FilterPopoverView = { fieldId: undefined, fromFields: true };

/**
 * One quiet bar above a list, in the spirit of Twenty: a search, the active filters as removable chips, "+ Filter"
 * (fields, then values), Sort, and an overflow with the columns. Generic: the consumer declares typed fields and owns
 * their state, so a view lives in the URL and can be shared. On a narrow screen the bar scrolls sideways with a fade.
 */
export function FilterBar({ label, search, fields = [], onClear, sort, columns, empty = false }: FilterBarProps) {
    const messages = useUiMessages();
    const { ref: popoverRef, open: popoverOpen, style: popoverStyle, show, hide } = useAnchoredPopover();
    const [view, setView] = useState<FilterPopoverView>(CLOSED);
    const addRef = useRef<HTMLButtonElement>(null);
    const wasOpenRef = useRef(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const active = fields.filter(isFieldActive);
    const searching = search !== undefined && search.value !== '';
    const edges = useScrollEdges(scrollRef, undefined, `${String(active.length)}:${String(searching)}`);
    const fade = edges.left && edges.right ? 'both' : edges.left ? 'left' : edges.right ? 'right' : null;
    if (empty && active.length === 0 && !searching) return null;

    const open = (anchor: HTMLElement, next: FilterPopoverView) => {
        setView(next);
        show(anchor);
    };
    const clearAll = () => {
        if (onClear !== undefined) onClear();
        else {
            for (const field of active) clearField(field);
            if (searching) search.onChange('');
        }
        addRef.current?.focus();
    };
    const openFieldId = popoverOpen ? view.fieldId : undefined;

    return (
        <div role="search" aria-label={label ?? messages.filters()} className="flex min-w-0 items-start gap-1">
            <div
                ref={scrollRef}
                className={cx(
                    'flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] md:flex-wrap md:overflow-visible',
                    fade !== null && FADE_CLASSES[fade],
                )}
            >
                {search === undefined ? null : <SearchBox {...search} />}
                {active.length === 0 ? null : (
                    <ul className="flex shrink-0 items-center gap-1 md:flex-wrap">
                        {active.map((field) => (
                            <FilterChip
                                key={field.id}
                                field={field}
                                expanded={openFieldId === field.id}
                                onEdit={(anchor) => {
                                    open(anchor, { fieldId: field.id, fromFields: false });
                                }}
                                onRemove={() => {
                                    clearField(field);
                                    addRef.current?.focus();
                                }}
                            />
                        ))}
                    </ul>
                )}
                {fields.length === 0 ? null : (
                    <Button
                        ref={addRef}
                        variant="ghost"
                        size="sm"
                        aria-haspopup="dialog"
                        aria-expanded={popoverOpen && openFieldId === undefined}
                        onMouseDown={() => {
                            // Pressing here moves focus out of an open popover, which closes it before the click.
                            wasOpenRef.current = popoverOpen;
                        }}
                        onClick={(event) => {
                            const wasOpen = popoverOpen || wasOpenRef.current;
                            wasOpenRef.current = false;
                            if (wasOpen) hide(false);
                            else open(event.currentTarget, CLOSED);
                        }}
                        className="text-(--filter-bar-muted)"
                    >
                        <Plus aria-hidden="true" className="size-4" />
                        {messages.addFilter()}
                    </Button>
                )}
                {active.length > 0 || searching ? (
                    <Button variant="ghost" size="sm" onClick={clearAll} className="text-(--filter-bar-muted)">
                        {messages.clearFilters()}
                    </Button>
                ) : null}
            </div>
            {sort === undefined || sort.options.length === 0 ? null : <SortMenu sort={sort} />}
            {columns === undefined || columns.items.length === 0 ? null : <ViewOptions columns={columns} />}
            <FilterPopover
                popoverRef={popoverRef}
                open={popoverOpen}
                style={popoverStyle}
                onClose={() => {
                    hide(true);
                }}
                fields={fields}
                view={view}
                onViewChange={setView}
            />
        </div>
    );
}

function SearchBox({ label, value, onChange, placeholder, maxLength, inputRef }: FilterBarSearch) {
    return (
        <div className="relative w-32 shrink-0 focus-within:w-44 md:w-56 md:focus-within:w-56 motion-safe:transition-[width] motion-safe:duration-(--motion-state)">
            <Search
                aria-hidden="true"
                className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-(--filter-bar-muted)"
            />
            <input
                {...(inputRef === undefined ? {} : { ref: inputRef })}
                type="search"
                aria-label={label}
                placeholder={placeholder ?? label}
                autoComplete="off"
                {...(maxLength === undefined ? {} : { maxLength })}
                value={value}
                onChange={(event) => {
                    onChange(event.target.value);
                }}
                className={cx(
                    'block min-h-8 w-full rounded-(--filter-bar-chip-radius) bg-transparent ps-8 pe-2 text-sm text-(--filter-bar-text)',
                    'placeholder:text-(--filter-bar-placeholder) hover:bg-(--filter-bar-hover) focus:bg-(--filter-bar-search-bg) focus-visible:outline-offset-0',
                    'motion-safe:transition-colors motion-safe:duration-(--motion-state)',
                )}
            />
        </div>
    );
}

/** A chip's day: "9 Nov", with the year only when it is not this year, so a range fits on a chip. */
function formatDay(day: string, locale: string, today: Date): string {
    const [year, month, date] = day.split('-').map(Number);
    if (year === undefined || month === undefined || date === undefined) return day;
    return new Intl.DateTimeFormat(locale, {
        day: 'numeric',
        month: 'short',
        ...(year === today.getFullYear() ? {} : { year: 'numeric' }),
    }).format(new Date(year, month - 1, date));
}

interface ChipValue {
    /** The first values, shown in full. */
    readonly shown: string;
    /** The rest, counted on screen and named for screen readers. */
    readonly hidden: readonly string[];
    readonly icon: ReactNode;
}

function useChipValue(field: FilterBarField): ChipValue {
    const messages = useUiMessages();
    const { locale } = useLocale();
    const today = new Date();
    if (field.kind === 'date-range') {
        const { from, to }: FilterBarDateRange = field.value;
        const start = from === undefined ? undefined : formatDay(from, locale, today);
        const end = to === undefined ? undefined : formatDay(to, locale, today);
        const shown =
            start !== undefined && end !== undefined
                ? start === end
                    ? start
                    : `${start} – ${end}`
                : start !== undefined
                  ? messages.rangeSince({ date: start })
                  : messages.rangeUntil({ date: end ?? '' });
        return { shown, hidden: [], icon: undefined };
    }
    const options: readonly FilterBarOption[] = selectedOptions(field);
    const labels = options.map((option) => option.label);
    return {
        shown: labels.slice(0, CHIP_VALUES).join(', '),
        hidden: labels.slice(CHIP_VALUES),
        // Only a lone value shows its face (an agent's avatar); several would crowd the chip.
        icon: options.length === 1 ? options[0]?.icon : undefined,
    };
}

function FilterChip({
    field,
    expanded,
    onEdit,
    onRemove,
}: {
    readonly field: FilterBarField;
    readonly expanded: boolean;
    readonly onEdit: (anchor: HTMLElement) => void;
    readonly onRemove: () => void;
}) {
    const messages = useUiMessages();
    const value = useChipValue(field);
    const fullText = `${field.label}: ${[value.shown, ...value.hidden].join(', ')}`;
    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== 'Backspace' && event.key !== 'Delete') return;
        event.preventDefault();
        onRemove();
    };
    return (
        <li className="flex min-h-7 max-w-72 shrink-0 items-stretch overflow-hidden rounded-(--filter-bar-chip-radius) border border-(--filter-bar-chip-border) bg-(--filter-bar-chip-bg) text-sm text-(--filter-bar-text)">
            <button
                type="button"
                aria-haspopup="dialog"
                aria-expanded={expanded}
                onClick={(event) => {
                    onEdit(event.currentTarget.parentElement ?? event.currentTarget);
                }}
                onKeyDown={onKeyDown}
                className="flex min-w-0 cursor-pointer items-center gap-1.5 ps-2 pe-1.5 hover:bg-(--filter-bar-hover) focus-visible:outline-offset-[-2px]"
            >
                {value.icon === undefined || value.icon === null ? null : (
                    <span aria-hidden="true" className="flex shrink-0 items-center">
                        {value.icon}
                    </span>
                )}
                <span className="shrink-0 text-(--filter-bar-muted)">{`${field.label}:`}</span>{' '}
                <span className="min-w-0 truncate font-medium">{value.shown}</span>
                {value.hidden.length === 0 ? null : (
                    <>
                        <span aria-hidden="true" className="shrink-0 text-(--filter-bar-muted) tabular-nums">
                            {`+${String(value.hidden.length)}`}
                        </span>
                        <span className="sr-only">{`, ${value.hidden.join(', ')}`}</span>
                    </>
                )}
            </button>
            <button
                type="button"
                aria-label={messages.removeFilter({ label: fullText })}
                onClick={onRemove}
                className="flex shrink-0 cursor-pointer items-center border-s border-(--filter-bar-chip-border) px-1.5 text-(--filter-bar-muted) hover:bg-(--filter-bar-hover) hover:text-(--filter-bar-text) focus-visible:outline-offset-[-2px]"
            >
                <X aria-hidden="true" className="size-3.5" />
            </button>
        </li>
    );
}

function SortMenu({ sort }: { readonly sort: FilterBarSort }) {
    const messages = useUiMessages();
    const { value, options, onChange } = sort;
    const current = value === undefined ? undefined : options.find((option) => option.id === value.id);
    const desc = value?.desc ?? false;
    const items: MenuEntry[] = [
        { kind: 'heading', id: 'by', label: messages.sort() },
        ...options.map((option): MenuEntry => ({
            kind: 'item',
            id: `by-${option.id}`,
            label: option.label,
            checked: option.id === value?.id,
            onSelect: () => {
                onChange({ id: option.id, desc });
            },
        })),
        { kind: 'separator', id: 'direction' },
        ...([false, true] as const).map((direction): MenuEntry => ({
            kind: 'item',
            id: direction ? 'desc' : 'asc',
            label: direction ? messages.descending() : messages.ascending(),
            icon: direction ? <ArrowDownWideNarrow className="size-4" /> : <ArrowUpNarrowWide className="size-4" />,
            checked: current !== undefined && desc === direction,
            disabled: current === undefined,
            onSelect: () => {
                if (current !== undefined) onChange({ id: current.id, desc: direction });
            },
        })),
    ];
    const Icon = desc ? ArrowDownWideNarrow : ArrowUpNarrowWide;
    return (
        <Menu
            label={messages.sort()}
            align="end"
            items={items}
            trigger={(triggerProps) => (
                <Button {...triggerProps} variant="ghost" size="sm" className="text-(--filter-bar-muted)">
                    <Icon aria-hidden="true" className="size-4" />
                    {/* On a phone the icon alone stays, so the chips keep the room; the name is still read out. */}
                    {current === undefined ? (
                        <span className="max-md:sr-only">{messages.sort()}</span>
                    ) : (
                        <>
                            <span aria-hidden="true" className="max-md:hidden">
                                {current.label}
                            </span>
                            <span className="sr-only">
                                {`${messages.sortedBy({ column: current.label })}, ${desc ? messages.sortDescending() : messages.sortAscending()}`}
                            </span>
                        </>
                    )}
                </Button>
            )}
        />
    );
}

function ViewOptions({ columns }: { readonly columns: FilterBarColumns }) {
    const messages = useUiMessages();
    const items: MenuEntry[] = [
        { kind: 'heading', id: 'columns', label: messages.columns() },
        ...columns.items.map((column): MenuEntry => ({
            kind: 'item',
            id: column.id,
            label: column.label,
            checked: column.visible,
            checkable: 'checkbox',
            disabled: column.disabled,
            onSelect: () => {
                columns.onToggle(column.id);
            },
        })),
    ];
    return (
        <Menu
            label={messages.viewOptions()}
            align="end"
            items={items}
            trigger={(triggerProps) => (
                <IconButton
                    {...triggerProps}
                    variant="ghost"
                    size="sm"
                    label={messages.viewOptions()}
                    icon={<Ellipsis aria-hidden="true" className="size-4" />}
                />
            )}
        />
    );
}
