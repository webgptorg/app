import { ChevronDown, Search, SlidersHorizontal, X } from 'lucide-react';
import { useId, useState } from 'react';
import type { Ref } from 'react';

import { useUiMessages } from '../../i18n/ui-provider';
import { cx } from '../../internal/cx';
import { Button } from '../button/button';
import { Checkbox } from '../checkbox/checkbox';
import { useNarrow } from '../data-table/use-narrow';
import { Drawer } from '../drawer/drawer';
import { Field } from '../field/field';
import { Input } from '../input/input';
import { Menu } from '../menu/menu';
import type { MenuEntry } from '../menu/menu';
import { Select } from '../select/select';

export interface FilterBarOption {
    readonly value: string;
    readonly label: string;
}

interface FilterBase {
    readonly id: string;
    /** The filter's name, e.g. "Status"; the trigger, the phone sheet and the active chips use it. */
    readonly label: string;
}

/** One choice or none, e.g. visibility. */
export interface FilterBarSelect extends FilterBase {
    readonly kind: 'select';
    readonly options: readonly FilterBarOption[];
    /** The "no filter" choice, e.g. "All agents". */
    readonly allLabel: string;
    readonly value: string | undefined;
    readonly onChange: (value: string | undefined) => void;
}

/** Any number of choices; none means no filter. The default for statuses. */
export interface FilterBarMulti extends FilterBase {
    readonly kind: 'multi';
    readonly options: readonly FilterBarOption[];
    readonly value: readonly string[];
    readonly onChange: (value: readonly string[]) => void;
}

/** A calendar day as `YYYY-MM-DD`, e.g. the start of a range. */
export interface FilterBarDate extends FilterBase {
    readonly kind: 'date';
    readonly value: string | undefined;
    readonly onChange: (value: string | undefined) => void;
    readonly min?: string;
    readonly max?: string;
    /** Shown under the field in the phone sheet, e.g. the time zone days are counted in. */
    readonly hint?: string;
}

/** Free text matched against one field, e.g. a target ID. */
export interface FilterBarText extends FilterBase {
    readonly kind: 'text';
    readonly value: string;
    readonly onChange: (value: string) => void;
}

export type FilterBarFilter = FilterBarSelect | FilterBarMulti | FilterBarDate | FilterBarText;

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

export interface FilterBarProps {
    readonly search?: FilterBarSearch;
    readonly filters: readonly FilterBarFilter[];
    /** Clears the search and every filter at once. */
    readonly onClear: () => void;
    /** The collection has nothing in it; the bar then renders nothing unless a search or filter is what emptied it. */
    readonly empty?: boolean;
    /** Names the search landmark; defaults to "Filters". */
    readonly label?: string;
}

interface ActiveValue {
    readonly key: string;
    readonly label: string;
    readonly remove: () => void;
}

function activeValues(filter: FilterBarFilter): readonly ActiveValue[] {
    const optionLabel = (options: readonly FilterBarOption[], value: string) =>
        options.find((option) => option.value === value)?.label ?? value;
    switch (filter.kind) {
        case 'select':
            return filter.value === undefined
                ? []
                : [
                      {
                          key: filter.id,
                          label: `${filter.label}: ${optionLabel(filter.options, filter.value)}`,
                          remove: () => {
                              filter.onChange(undefined);
                          },
                      },
                  ];
        case 'multi':
            return filter.value.map((value) => ({
                key: `${filter.id}:${value}`,
                label: `${filter.label}: ${optionLabel(filter.options, value)}`,
                remove: () => {
                    filter.onChange(filter.value.filter((entry) => entry !== value));
                },
            }));
        case 'date':
        case 'text':
            return filter.value === undefined || filter.value === ''
                ? []
                : [
                      {
                          key: filter.id,
                          label: `${filter.label}: ${filter.value}`,
                          remove: () => {
                              if (filter.kind === 'date') filter.onChange(undefined);
                              else filter.onChange('');
                          },
                      },
                  ];
    }
}

function isActive(filter: FilterBarFilter): boolean {
    return activeValues(filter).length > 0;
}

/**
 * The one filter pattern for every list: a search and compact filter triggers in one row on desktop; on a phone only
 * the search stays, the rest collapses into a "Filters" sheet with the active count, and active filters show as
 * removable chips, so the content starts on the first screen.
 *
 * Statuses are `multi` (a checkbox menu whose trigger counts the choices); single choices are `select`. Bind every
 * value to the URL so a filtered list can be shared and restored.
 */
export function FilterBar({ search, filters, onClear, empty = false, label }: FilterBarProps) {
    const messages = useUiMessages();
    const narrow = useNarrow();
    const [sheetOpen, setSheetOpen] = useState(false);
    const activeCount = filters.filter(isActive).length;
    const searching = search !== undefined && search.value !== '';
    if (empty && activeCount === 0 && !searching) return null;
    const name = label ?? messages.filters();

    if (!narrow) {
        return (
            <div role="search" aria-label={name} className="flex flex-wrap items-center gap-2">
                {search === undefined ? null : <SearchInput {...search} className="w-full sm:w-64" />}
                {filters.map((filter) => (
                    <CompactFilter key={filter.id} filter={filter} />
                ))}
                {activeCount > 0 || searching ? (
                    <Button variant="ghost" onClick={onClear}>
                        {messages.clearFilters()}
                    </Button>
                ) : null}
            </div>
        );
    }

    const chips = filters.flatMap(activeValues);
    return (
        <div role="search" aria-label={name} className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
                {search === undefined ? null : <SearchInput {...search} className="min-w-0 flex-1" />}
                {filters.length === 0 ? null : (
                    <Button
                        aria-haspopup="dialog"
                        onClick={() => {
                            setSheetOpen(true);
                        }}
                        className="shrink-0"
                    >
                        <SlidersHorizontal aria-hidden="true" className="size-4" />
                        {messages.filters()}
                        {activeCount === 0 ? null : (
                            <Count value={activeCount} label={messages.filtersActive({ count: activeCount })} />
                        )}
                    </Button>
                )}
            </div>
            {chips.length === 0 ? null : (
                <ul className="flex flex-wrap items-center gap-2">
                    {chips.map((chip) => (
                        <li key={chip.key} className="min-w-0">
                            <button
                                type="button"
                                aria-label={messages.removeFilter({ label: chip.label })}
                                onClick={chip.remove}
                                className="inline-flex min-h-8 max-w-full cursor-pointer items-center gap-1 rounded-pill border border-(--filter-bar-chip-border) bg-(--filter-bar-chip-bg) ps-3 pe-2 text-sm text-(--filter-bar-chip-text) hover:bg-(--filter-bar-chip-hover)"
                            >
                                <span className="truncate">{chip.label}</span>
                                <X aria-hidden="true" className="size-3.5 shrink-0" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <Drawer
                open={sheetOpen}
                onClose={() => {
                    setSheetOpen(false);
                }}
                title={messages.filters()}
                footer={
                    <>
                        {activeCount > 0 ? (
                            <Button variant="ghost" onClick={onClear}>
                                {messages.clearFilters()}
                            </Button>
                        ) : null}
                        <Button
                            variant="primary"
                            onClick={() => {
                                setSheetOpen(false);
                            }}
                        >
                            {messages.showResults()}
                        </Button>
                    </>
                }
            >
                <div className="flex flex-col gap-5">
                    {filters.map((filter) => (
                        <SheetFilter key={filter.id} filter={filter} />
                    ))}
                </div>
            </Drawer>
        </div>
    );
}

/**
 * The visible number, and for screen readers the same count in words; content rather than `aria-label`, so the
 * button's name still starts with its visible text (WCAG 2.5.3).
 */
function Count({ value, label }: { readonly value: number; readonly label: string }) {
    return (
        <>
            {' '}
            <span
                aria-hidden="true"
                className="inline-flex min-w-5 items-center justify-center rounded-pill bg-(--filter-bar-count-bg) px-1.5 text-xs font-medium text-(--filter-bar-count-text)"
            >
                {value}
            </span>
            <span className="sr-only">{label}</span>
        </>
    );
}

function SearchInput({
    label,
    value,
    onChange,
    placeholder,
    maxLength,
    inputRef,
    className,
}: FilterBarSearch & { readonly className: string }) {
    return (
        <div className={cx('relative', className)}>
            <Search
                aria-hidden="true"
                className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-(--filter-bar-icon)"
            />
            <Input
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
                className="ps-9"
            />
        </div>
    );
}

function CompactFilter({ filter }: { readonly filter: FilterBarFilter }) {
    const messages = useUiMessages();
    switch (filter.kind) {
        case 'select':
            // The wrapper sizes the full-width control to its content, so the row stays compact.
            return (
                <div className="max-w-full">
                    <Select
                        aria-label={filter.label}
                        value={filter.value ?? ''}
                        onChange={(event) => {
                            filter.onChange(event.target.value === '' ? undefined : event.target.value);
                        }}
                        data-filter-active={filter.value === undefined ? undefined : ''}
                    >
                        <option value="">{filter.allLabel}</option>
                        {filter.options.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </Select>
                </div>
            );
        case 'multi': {
            const count = filter.value.length;
            const items: MenuEntry[] = filter.options.map((option) => ({
                kind: 'item',
                id: option.value,
                label: option.label,
                checkable: 'checkbox',
                checked: filter.value.includes(option.value),
                onSelect: () => {
                    filter.onChange(
                        filter.value.includes(option.value)
                            ? filter.value.filter((value) => value !== option.value)
                            : [...filter.value, option.value],
                    );
                },
            }));
            return (
                <Menu
                    label={filter.label}
                    items={items}
                    trigger={(triggerProps) => (
                        <Button
                            {...triggerProps}
                            data-filter-active={count === 0 ? undefined : ''}
                            className="max-w-full"
                        >
                            <span className="truncate">{filter.label}</span>
                            {count === 0 ? null : <Count value={count} label={messages.filterSelected({ count })} />}
                            <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
                        </Button>
                    )}
                />
            );
        }
        case 'date':
            return (
                <label className="inline-flex items-center gap-2 text-sm text-(--filter-bar-label)">
                    <span className="whitespace-nowrap">{filter.label}</span>
                    <Input
                        type="date"
                        value={filter.value ?? ''}
                        {...(filter.min === undefined ? {} : { min: filter.min })}
                        {...(filter.max === undefined ? {} : { max: filter.max })}
                        onChange={(event) => {
                            filter.onChange(event.target.value === '' ? undefined : event.target.value);
                        }}
                        className="w-auto"
                    />
                </label>
            );
        case 'text':
            return (
                <Input
                    type="search"
                    aria-label={filter.label}
                    placeholder={filter.label}
                    value={filter.value}
                    onChange={(event) => {
                        filter.onChange(event.target.value);
                    }}
                    className="w-full sm:w-48"
                />
            );
    }
}

function SheetFilter({ filter }: { readonly filter: FilterBarFilter }) {
    const legendId = useId();
    switch (filter.kind) {
        case 'select':
            return (
                <Field label={filter.label}>
                    {(control) => (
                        <Select
                            {...control}
                            value={filter.value ?? ''}
                            onChange={(event) => {
                                filter.onChange(event.target.value === '' ? undefined : event.target.value);
                            }}
                        >
                            <option value="">{filter.allLabel}</option>
                            {filter.options.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </Select>
                    )}
                </Field>
            );
        case 'multi':
            return (
                <fieldset aria-labelledby={legendId} className="flex flex-col gap-2">
                    <legend id={legendId} className="mb-1 text-sm font-medium">
                        {filter.label}
                    </legend>
                    {filter.options.map((option) => (
                        <Checkbox
                            key={option.value}
                            label={option.label}
                            checked={filter.value.includes(option.value)}
                            onChange={(event) => {
                                filter.onChange(
                                    event.target.checked
                                        ? [...filter.value, option.value]
                                        : filter.value.filter((value) => value !== option.value),
                                );
                            }}
                        />
                    ))}
                </fieldset>
            );
        case 'date':
            return (
                <Field label={filter.label} {...(filter.hint === undefined ? {} : { hint: filter.hint })}>
                    {(control) => (
                        <Input
                            {...control}
                            type="date"
                            value={filter.value ?? ''}
                            {...(filter.min === undefined ? {} : { min: filter.min })}
                            {...(filter.max === undefined ? {} : { max: filter.max })}
                            onChange={(event) => {
                                filter.onChange(event.target.value === '' ? undefined : event.target.value);
                            }}
                        />
                    )}
                </Field>
            );
        case 'text':
            return (
                <Field label={filter.label}>
                    {(control) => (
                        <Input
                            {...control}
                            type="search"
                            value={filter.value}
                            onChange={(event) => {
                                filter.onChange(event.target.value);
                            }}
                        />
                    )}
                </Field>
            );
    }
}
