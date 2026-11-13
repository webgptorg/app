import { Check, ChevronLeft } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { useUiMessages } from '../../i18n/ui-provider';
import { cx } from '../../internal/cx';
import { Button } from '../button/button';
import { Input } from '../input/input';
import type { AnchoredPopover } from './anchored-popover';
import { isMultiple, matchesQuery, selectedOptions } from './filter-fields';
import type { FilterBarDateRangeField, FilterBarField, FilterBarOption } from './filter-fields';

/** Where the popover is: the list of fields, or one field's values. */
export interface FilterPopoverView {
    readonly fieldId: string | undefined;
    /** Opened from "+ Filter", so a step back to the field list makes sense; from a chip it does not. */
    readonly fromFields: boolean;
}

/** A value list longer than this gets a search box; entities always have one. */
const SEARCH_ABOVE = 7;

export interface FilterPopoverProps {
    readonly popoverRef: AnchoredPopover['ref'];
    readonly open: boolean;
    readonly style: AnchoredPopover['style'];
    readonly onClose: () => void;
    readonly fields: readonly FilterBarField[];
    readonly view: FilterPopoverView;
    readonly onViewChange: (view: FilterPopoverView) => void;
}

/**
 * "+ Filter" and every chip open this one non-modal dialog: first a list of fields, then the values of the chosen one
 * (a listbox, with a search for entities and long lists) or a date range. Values apply as they are picked, so the
 * chip and the list update live behind it.
 */
export function FilterPopover({ popoverRef, open, style, onClose, fields, view, onViewChange }: FilterPopoverProps) {
    const messages = useUiMessages();
    const field = view.fieldId === undefined ? undefined : fields.find((candidate) => candidate.id === view.fieldId);
    const back =
        view.fromFields && field !== undefined
            ? () => {
                  onViewChange({ fieldId: undefined, fromFields: true });
              }
            : undefined;

    const content = (() => {
        if (!open) return null;
        if (field === undefined) {
            return (
                <OptionList
                    key="fields"
                    label={messages.filterBy()}
                    options={fields.map((candidate) => ({
                        value: candidate.id,
                        label: candidate.label,
                        ...(candidate.icon === undefined ? {} : { icon: candidate.icon }),
                    }))}
                    selected={NOTHING}
                    multiple={false}
                    searchable={false}
                    onPick={(fieldId) => {
                        onViewChange({ fieldId, fromFields: true });
                    }}
                />
            );
        }
        if (field.kind === 'date-range') {
            return <DateRangeStep key={field.id} field={field} onBack={back} onDone={onClose} />;
        }
        const multiple = isMultiple(field);
        const selected = new Set(selectedOptions(field).map((option) => option.value));
        return (
            <StepWithHeader key={field.id} title={field.label} onBack={back}>
                <OptionList
                    label={field.label}
                    options={field.options}
                    selected={selected}
                    multiple={multiple}
                    searchable={field.kind === 'entity' || field.options.length > SEARCH_ABOVE}
                    {...(back === undefined ? {} : { onBack: back })}
                    onPick={(value) => {
                        pick(field, value);
                        if (!multiple) onClose();
                    }}
                />
            </StepWithHeader>
        );
    })();

    const title = field?.label ?? messages.addFilter();
    return (
        <div
            ref={popoverRef}
            popover="auto"
            // Closed, it is an empty hidden box; the role and name come with the content.
            {...(open ? { role: 'dialog', 'aria-label': title } : {})}
            style={style}
            className={cx(
                'fixed inset-auto m-0 hidden max-h-[min(24rem,calc(100dvh-var(--spacing)*4))] w-64 max-w-[calc(100vw-var(--spacing)*4)] flex-col overflow-hidden p-1 [&:popover-open]:flex',
                'rounded-(--filter-bar-popover-radius) border border-(--filter-bar-popover-border) bg-(--filter-bar-popover-bg) text-sm text-(--filter-bar-text) shadow-(--filter-bar-popover-shadow)',
                'motion-safe:animate-[ptbk-menu-enter_var(--motion-enter)_var(--ease-enter)]',
            )}
        >
            {content}
        </div>
    );
}

const NOTHING: ReadonlySet<string> = new Set();

function pick(field: Exclude<FilterBarField, FilterBarDateRangeField>, value: string): void {
    switch (field.kind) {
        case 'enum':
            field.onChange(field.value === value ? undefined : value);
            return;
        case 'multi-enum':
        case 'entity': {
            if (!isMultiple(field)) {
                field.onChange(field.value.includes(value) ? [] : [value]);
                return;
            }
            field.onChange(
                field.value.includes(value) ? field.value.filter((entry) => entry !== value) : [...field.value, value],
            );
            return;
        }
    }
}

/** The option a pointer event happened on, by its position in the visible list. */
function optionIndex(target: EventTarget): number | undefined {
    if (!(target instanceof Element)) return undefined;
    const index = target.closest('[role="option"]')?.getAttribute('data-index');
    return index === null || index === undefined ? undefined : Number(index);
}

function StepWithHeader({
    title,
    onBack,
    children,
}: {
    readonly title: string;
    readonly onBack: (() => void) | undefined;
    readonly children: ReactNode;
}) {
    const messages = useUiMessages();
    return (
        <>
            <div className="flex min-h-8 items-center gap-1 px-1 pb-1 text-xs font-medium text-(--filter-bar-muted)">
                {onBack === undefined ? (
                    <span className="px-1">{title}</span>
                ) : (
                    <button
                        type="button"
                        onClick={onBack}
                        aria-label={messages.backToFilters()}
                        className="inline-flex min-h-7 cursor-pointer items-center gap-1 rounded-(--filter-bar-item-radius) pe-2 ps-1 hover:bg-(--filter-bar-item-active) hover:text-(--filter-bar-text)"
                    >
                        <ChevronLeft aria-hidden="true" className="size-3.5" />
                        {title}
                    </button>
                )}
            </div>
            {children}
        </>
    );
}

interface OptionListProps {
    readonly label: string;
    readonly options: readonly FilterBarOption[];
    readonly selected: ReadonlySet<string>;
    readonly multiple: boolean;
    readonly searchable: boolean;
    readonly onPick: (value: string) => void;
    /** Backspace in an empty search (or on the list) steps back to the fields. */
    readonly onBack?: () => void;
}

/**
 * A listbox driven by `aria-activedescendant`, so focus stays on one element: the search box when there is one (the
 * combobox pattern), else the list itself. Arrows move, Enter picks; Space picks too when there is nothing to type in.
 */
function OptionList({ label, options, selected, multiple, searchable, onPick, onBack }: OptionListProps) {
    const messages = useUiMessages();
    const listId = useId();
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const focusRef = useRef<HTMLElement | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const visible = query === '' ? options : options.filter((option) => matchesQuery(option.label, query));
    const activeIndex = Math.min(active, Math.max(visible.length - 1, 0));
    const optionId = (index: number) => `${listId}-${String(index)}`;
    const activeId = visible.length === 0 ? undefined : optionId(activeIndex);

    useEffect(() => {
        focusRef.current?.focus();
    }, []);
    useEffect(() => {
        if (activeId === undefined) return;
        listRef.current?.querySelector(`[id="${activeId}"]`)?.scrollIntoView({ block: 'nearest' });
    }, [activeId]);

    const pickAt = (index: number) => {
        const option = visible[index];
        if (option !== undefined) onPick(option.value);
    };
    const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
        const count = visible.length;
        const move = (index: number) => {
            event.preventDefault();
            if (count > 0) setActive(((index % count) + count) % count);
        };
        switch (event.key) {
            case 'ArrowDown':
                move(activeIndex + 1);
                return;
            case 'ArrowUp':
                move(activeIndex - 1);
                return;
            case 'Home':
            case 'End':
                // In a search box they move the caret.
                if (!searchable) move(event.key === 'Home' ? 0 : count - 1);
                return;
            case 'Enter':
                event.preventDefault();
                pickAt(activeIndex);
                return;
            case ' ':
                if (searchable) return;
                event.preventDefault();
                pickAt(activeIndex);
                return;
            case 'Backspace':
                if (onBack !== undefined && query === '') {
                    event.preventDefault();
                    onBack();
                }
                return;
        }
    };

    const list = (
        <div
            ref={(element) => {
                listRef.current = element;
                if (!searchable) focusRef.current = element;
            }}
            id={listId}
            role="listbox"
            aria-label={label}
            aria-multiselectable={multiple || undefined}
            // With a search box, focus stays there and the list is only reachable by pointer.
            tabIndex={searchable ? -1 : 0}
            aria-activedescendant={searchable ? undefined : activeId}
            onKeyDown={onKeyDown}
            onMouseDown={(event) => {
                // Keeps focus (and the caret) where it is.
                event.preventDefault();
            }}
            onMouseMove={(event) => {
                const index = optionIndex(event.target);
                if (index !== undefined && index !== activeIndex) setActive(index);
            }}
            onClick={(event) => {
                const index = optionIndex(event.target);
                if (index === undefined) return;
                setActive(index);
                pickAt(index);
            }}
            className="min-h-0 flex-1 overflow-y-auto rounded-(--filter-bar-item-radius) focus-visible:outline-offset-[-2px]"
        >
            {visible.map((option, index) => {
                const isSelected = selected.has(option.value);
                return (
                    <div
                        key={option.value}
                        id={optionId(index)}
                        role="option"
                        aria-selected={isSelected}
                        data-index={index}
                        data-active={index === activeIndex ? '' : undefined}
                        className="flex min-h-8 cursor-pointer items-center gap-2 rounded-(--filter-bar-item-radius) px-2 py-1 data-active:bg-(--filter-bar-item-active)"
                    >
                        {multiple ? (
                            <span
                                aria-hidden="true"
                                className={cx(
                                    'flex size-4 shrink-0 items-center justify-center rounded-[calc(var(--filter-bar-item-radius)/2)] border',
                                    isSelected
                                        ? 'border-(--filter-bar-check-bg) bg-(--filter-bar-check-bg) text-(--filter-bar-check-text)'
                                        : 'border-(--filter-bar-check-border)',
                                )}
                            >
                                {isSelected ? <Check className="size-3" strokeWidth={3} /> : null}
                            </span>
                        ) : null}
                        {option.icon === undefined ? null : (
                            <span aria-hidden="true" className="flex shrink-0 items-center">
                                {option.icon}
                            </span>
                        )}
                        <span className="min-w-0 flex-1 truncate">{option.label}</span>
                        {!multiple && isSelected ? (
                            <Check aria-hidden="true" className="size-4 shrink-0 text-(--filter-bar-check-mark)" />
                        ) : null}
                    </div>
                );
            })}
        </div>
    );

    return (
        <>
            {searchable ? (
                <div className="px-1 pb-1">
                    <input
                        ref={(element) => {
                            focusRef.current = element;
                        }}
                        type="text"
                        role="combobox"
                        aria-expanded="true"
                        aria-controls={listId}
                        aria-autocomplete="list"
                        aria-activedescendant={activeId}
                        aria-label={messages.searchOptions({ label })}
                        placeholder={messages.searchOptions({ label })}
                        autoComplete="off"
                        spellCheck={false}
                        value={query}
                        onChange={(event) => {
                            setQuery(event.target.value);
                            setActive(0);
                        }}
                        onKeyDown={onKeyDown}
                        className="block min-h-8 w-full rounded-(--filter-bar-item-radius) bg-(--filter-bar-search-bg) px-2 text-sm text-(--filter-bar-text) placeholder:text-(--filter-bar-placeholder) focus-visible:outline-offset-0"
                    />
                </div>
            ) : null}
            {list}
            {visible.length === 0 ? (
                <p role="status" className="px-2 py-1.5 text-(--filter-bar-muted)">
                    {messages.noMatches()}
                </p>
            ) : null}
        </>
    );
}

function DateRangeStep({
    field,
    onBack,
    onDone,
}: {
    readonly field: FilterBarDateRangeField;
    readonly onBack: (() => void) | undefined;
    readonly onDone: () => void;
}) {
    const messages = useUiMessages();
    const hintId = useId();
    const firstRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        firstRef.current?.focus();
    }, []);
    const { from, to } = field.value;
    const fromMax = to ?? field.max;
    const toMin = from ?? field.min;
    const describedBy = field.hint === undefined ? undefined : hintId;
    return (
        <StepWithHeader title={field.label} onBack={onBack}>
            <div className="flex flex-col gap-2 px-1 pb-1">
                <label className="flex items-center justify-between gap-3">
                    <span className="text-(--filter-bar-muted)">{messages.rangeFrom()}</span>
                    <Input
                        ref={firstRef}
                        type="date"
                        value={from ?? ''}
                        {...(field.min === undefined ? {} : { min: field.min })}
                        {...(fromMax === undefined ? {} : { max: fromMax })}
                        aria-describedby={describedBy}
                        onChange={(event) => {
                            field.onChange({ from: event.target.value === '' ? undefined : event.target.value, to });
                        }}
                        className="w-40"
                    />
                </label>
                <label className="flex items-center justify-between gap-3">
                    <span className="text-(--filter-bar-muted)">{messages.rangeTo()}</span>
                    <Input
                        type="date"
                        value={to ?? ''}
                        {...(toMin === undefined ? {} : { min: toMin })}
                        {...(field.max === undefined ? {} : { max: field.max })}
                        aria-describedby={describedBy}
                        onChange={(event) => {
                            field.onChange({ from, to: event.target.value === '' ? undefined : event.target.value });
                        }}
                        className="w-40"
                    />
                </label>
                {field.hint === undefined ? null : (
                    <p id={hintId} className="text-xs text-(--filter-bar-muted)">
                        {field.hint}
                    </p>
                )}
                <div className="flex justify-end">
                    <Button size="sm" variant="ghost" onClick={onDone}>
                        {messages.done()}
                    </Button>
                </div>
            </div>
        </StepWithHeader>
    );
}
