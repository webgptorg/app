import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, FocusEvent, KeyboardEvent, ReactNode } from 'react';

import { useUiMessages } from '../../i18n/ui-provider';
import { controlClassName, invalidAttribute } from '../../internal/control';
import { cx } from '../../internal/cx';

export interface ComboboxOption {
    readonly value: string;
    /** Rendered as text; also what typeahead and the search match. */
    readonly label: string;
    readonly description?: string;
    /** A decorative icon or avatar before the label. */
    readonly leading?: ReactNode;
    readonly disabled?: boolean;
}

export interface ComboboxProps {
    readonly options: readonly ComboboxOption[];
    readonly value: string | null;
    readonly onChange: (value: string) => void;
    readonly placeholder?: string;
    /** Adds a filter field in the popup, for long lists (agents, members). */
    readonly searchable?: boolean;
    readonly searchPlaceholder?: string;
    readonly invalid?: boolean;
    readonly disabled?: boolean;
    /** 32px, or 40px like `Input`, `Select` and `DateInput`. */
    readonly size?: 'sm' | 'md';
    /** Posts the value with a form through a hidden input. */
    readonly name?: string;
    readonly id?: string;
    readonly 'aria-label'?: string;
    readonly 'aria-labelledby'?: string;
    readonly 'aria-describedby'?: string | undefined;
    readonly 'aria-invalid'?: boolean | 'true' | 'false' | undefined;
    readonly required?: boolean;
    /** Called when focus leaves the trigger and its popup. */
    readonly onBlur?: () => void;
    readonly className?: string;
}

const GAP = 4;
const VIEWPORT_MARGIN = 8;
const PAGE_STEP = 10;
const TYPEAHEAD_RESET_MS = 500;

const SIZE_CLASSES = { sm: 'min-h-8', md: 'min-h-10' } as const;

interface Placement {
    /** Above the trigger the popup is held by its bottom edge, so a shrinking filtered list stays attached. */
    readonly side: 'below' | 'above';
    readonly offset: number;
    readonly left: number;
    readonly minWidth: number;
}

function place(trigger: DOMRect, popup: DOMRect): Placement {
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const minWidth = Math.min(trigger.width, viewportWidth - 2 * VIEWPORT_MARGIN);
    const width = Math.max(popup.width, minWidth);
    const left = Math.min(
        Math.max(trigger.left, VIEWPORT_MARGIN),
        Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN),
    );
    const fitsBelow = trigger.bottom + GAP + popup.height <= viewportHeight - VIEWPORT_MARGIN;
    const fitsAbove = trigger.top - GAP - popup.height >= VIEWPORT_MARGIN;
    if (!fitsBelow && fitsAbove) return { side: 'above', offset: viewportHeight - trigger.top + GAP, left, minWidth };
    return { side: 'below', offset: trigger.bottom + GAP, left, minWidth };
}

/** Case- and diacritic-insensitive, so "sar" finds "Šárka". */
function searchText(text: string): string {
    return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

function filterOptions(options: readonly ComboboxOption[], query: string): readonly ComboboxOption[] {
    const needle = searchText(query.trim());
    return needle === '' ? options : options.filter((option) => searchText(option.label).includes(needle));
}

/** The first enabled option from `start` walking by `step`, or -1. */
function enabledFrom(options: readonly ComboboxOption[], start: number, step: 1 | -1): number {
    for (let index = start; index >= 0 && index < options.length; index += step) {
        if (options[index]?.disabled !== true) return index;
    }
    return -1;
}

/** Where a navigation key moves the active option: an index, -1 for nowhere, `undefined` for not a navigation key. */
function navigate(options: readonly ComboboxOption[], active: number, key: string): number | undefined {
    const last = options.length - 1;
    switch (key) {
        case 'ArrowDown':
            return enabledFrom(options, active + 1, 1);
        case 'ArrowUp':
            return enabledFrom(options, active - 1, -1);
        case 'Home':
            return enabledFrom(options, 0, 1);
        case 'End':
            return enabledFrom(options, last, -1);
        case 'PageDown': {
            const target = Math.min(active + PAGE_STEP, last);
            const forward = enabledFrom(options, target, 1);
            return forward === -1 ? enabledFrom(options, target, -1) : forward;
        }
        case 'PageUp': {
            const target = Math.max(active - PAGE_STEP, 0);
            const backward = enabledFrom(options, target, -1);
            return backward === -1 ? enabledFrom(options, target, 1) : backward;
        }
        default:
            return undefined;
    }
}

function isPrintable(event: KeyboardEvent<HTMLElement>): boolean {
    return event.key.length === 1 && /\S/u.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/** The text of the trigger's `<label>`s without their decorative parts (a required asterisk), to name the popup. */
function labelText(trigger: HTMLButtonElement): string | undefined {
    const text = (node: Node): string => {
        if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return '';
        if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
        return [...node.childNodes].map(text).join('');
    };
    const joined = [...trigger.labels].map(text).join(' ').trim();
    return joined === '' ? undefined : joined;
}

/**
 * A select that can show icons, descriptions and a search field, following the WAI-ARIA select-only combobox (and,
 * when searchable, the combobox with a listbox popup). The popup sits in the top layer through the Popover API and is
 * placed through the CSSOM, so the engine's CSP holds; it closes when the page scrolls under it.
 */
export function Combobox({
    options,
    value,
    onChange,
    placeholder,
    searchable = false,
    searchPlaceholder,
    invalid,
    disabled = false,
    size = 'md',
    name,
    id,
    required = false,
    onBlur,
    className,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
}: ComboboxProps) {
    const messages = useUiMessages();
    const generatedId = useId();
    const triggerId = id ?? generatedId;
    const listboxId = useId();
    const triggerRef = useRef<HTMLButtonElement>(null);
    const popupRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const typeahead = useRef<{ text: string; timer: ReturnType<typeof setTimeout> | undefined }>({
        text: '',
        timer: undefined,
    });
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(-1);
    const [placement, setPlacement] = useState<Placement | null>(null);
    const [popupLabel, setPopupLabel] = useState<string | undefined>(undefined);

    const visible = searchable ? filterOptions(options, query) : options;
    const selected = options.find((option) => option.value === value);
    const optionId = (index: number) => `${listboxId}-${String(index)}`;
    const activeId = visible[activeIndex] === undefined ? undefined : optionId(activeIndex);

    const close = useCallback((returnFocus: boolean) => {
        // Focus moves before the popup hides, so the search field's blur never looks like focus leaving the widget.
        if (returnFocus) triggerRef.current?.focus();
        popupRef.current?.togglePopover(false);
        setOpen(false);
        setQuery('');
    }, []);

    const show = (initial: 'selected' | 'first' | 'last', initialQuery = '') => {
        const trigger = triggerRef.current;
        if (trigger === null) return;
        const list = searchable ? filterOptions(options, initialQuery) : options;
        const selectedIndex = list.findIndex((option) => option.value === value && option.disabled !== true);
        setQuery(initialQuery);
        setActiveIndex(
            initial === 'last'
                ? enabledFrom(list, list.length - 1, -1)
                : initial === 'selected' && selectedIndex !== -1
                  ? selectedIndex
                  : enabledFrom(list, 0, 1),
        );
        setPopupLabel(ariaLabel ?? labelText(trigger));
        popupRef.current?.togglePopover(true);
        setOpen(true);
        // Safari does not focus a clicked button; the trigger holds focus while the list is open.
        if (!searchable) trigger.focus();
    };

    const commit = (index: number, returnFocus: boolean): boolean => {
        const option = visible[index];
        if (option === undefined || option.disabled === true) return false;
        if (option.value !== value) onChange(option.value);
        close(returnFocus);
        return true;
    };

    const typeAhead = (key: string, from: number): number => {
        const state = typeahead.current;
        clearTimeout(state.timer);
        state.text += searchText(key);
        state.timer = setTimeout(() => {
            state.text = '';
        }, TYPEAHEAD_RESET_MS);
        // Pressing one letter again cycles through the options that start with it.
        const repeated = state.text === state.text.charAt(0).repeat(state.text.length);
        const prefix = repeated ? state.text.slice(0, 1) : state.text;
        const start = repeated ? from + 1 : Math.max(from, 0);
        for (let step = 0; step < visible.length; step += 1) {
            const index = (start + step) % visible.length;
            const option = visible[index];
            if (option !== undefined && option.disabled !== true && searchText(option.label).startsWith(prefix)) {
                return index;
            }
        }
        return -1;
    };

    const onOpenKeyDown = (event: KeyboardEvent<HTMLElement>) => {
        const fromSearch = event.currentTarget === searchRef.current;
        switch (event.key) {
            case 'Escape':
                event.preventDefault();
                // Esc closes the list only; a dialog around it stays open.
                event.stopPropagation();
                close(true);
                return;
            case 'Enter':
                event.preventDefault();
                commit(activeIndex, true);
                return;
            case 'Tab':
                if (!commit(activeIndex, false)) close(false);
                return;
            case ' ':
                if (fromSearch) return;
                event.preventDefault();
                commit(activeIndex, true);
                return;
            case 'Home':
            case 'End':
                // In the search field they move the caret.
                if (fromSearch) return;
        }
        const next = navigate(visible, activeIndex, event.key);
        if (next !== undefined) {
            event.preventDefault();
            if (next !== -1) setActiveIndex(next);
            return;
        }
        if (!fromSearch && isPrintable(event)) {
            const match = typeAhead(event.key, activeIndex);
            if (match !== -1) setActiveIndex(match);
        }
    };

    const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (open) {
            onOpenKeyDown(event);
            return;
        }
        switch (event.key) {
            case 'ArrowDown':
            case 'ArrowUp':
            case 'Enter':
            case ' ':
                event.preventDefault();
                show('selected');
                return;
            case 'Home':
                event.preventDefault();
                show('first');
                return;
            case 'End':
                event.preventDefault();
                show('last');
                return;
        }
        if (!isPrintable(event)) return;
        event.preventDefault();
        if (searchable) {
            show('first', event.key);
            return;
        }
        show('selected');
        const match = typeAhead(
            event.key,
            options.findIndex((option) => option.value === value),
        );
        if (match !== -1) setActiveIndex(match);
    };

    const onFocusOut = (event: FocusEvent<HTMLElement>) => {
        const next = event.relatedTarget;
        if (
            next instanceof Node &&
            (popupRef.current?.contains(next) === true || triggerRef.current?.contains(next) === true)
        ) {
            return;
        }
        if (open) close(false);
        onBlur?.();
    };

    useLayoutEffect(() => {
        const popup = popupRef.current;
        const trigger = triggerRef.current;
        if (!open || popup === null || trigger === null) return;
        const reposition = () => {
            setPlacement(place(trigger.getBoundingClientRect(), popup.getBoundingClientRect()));
        };
        reposition();
        const search = searchRef.current;
        if (search !== null) {
            search.focus();
            search.setSelectionRange(search.value.length, search.value.length);
        }
        const onScroll = (event: Event) => {
            if (event.target instanceof Node && popup.contains(event.target)) return;
            close(false);
        };
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Node && (popup.contains(target) || trigger.contains(target))) return;
            close(false);
        };
        window.addEventListener('resize', reposition);
        window.addEventListener('scroll', onScroll, true);
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => {
            window.removeEventListener('resize', reposition);
            window.removeEventListener('scroll', onScroll, true);
            document.removeEventListener('pointerdown', onPointerDown, true);
        };
    }, [open, close]);

    useLayoutEffect(() => {
        if (open && activeIndex !== -1)
            listRef.current?.children.item(activeIndex)?.scrollIntoView({ block: 'nearest' });
    }, [open, activeIndex]);

    useEffect(() => {
        const state = typeahead.current;
        return () => {
            clearTimeout(state.timer);
        };
    }, []);

    const style: CSSProperties | undefined =
        placement === null
            ? undefined
            : placement.side === 'below'
              ? { top: placement.offset, left: placement.left, minWidth: placement.minWidth }
              : { bottom: placement.offset, left: placement.left, minWidth: placement.minWidth };

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                id={triggerId}
                role="combobox"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={listboxId}
                aria-activedescendant={open && !searchable ? activeId : undefined}
                aria-label={ariaLabel}
                aria-labelledby={ariaLabelledBy}
                aria-describedby={ariaDescribedBy}
                aria-invalid={invalidAttribute(invalid, ariaInvalid)}
                aria-required={required ? true : undefined}
                disabled={disabled}
                onClick={() => {
                    if (open) close(true);
                    else show('selected');
                }}
                onKeyDown={onTriggerKeyDown}
                onKeyUp={(event) => {
                    // Space already acted on keydown; its native click on keyup would toggle the list back.
                    if (event.key === ' ') event.preventDefault();
                }}
                onBlur={onFocusOut}
                className={controlClassName(cx('cursor-pointer text-start', SIZE_CLASSES[size], className))}
            >
                <span className="flex min-w-0 items-center gap-2">
                    {selected?.leading === undefined ? null : (
                        <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
                            {selected.leading}
                        </span>
                    )}
                    {selected === undefined ? (
                        <span className="min-w-0 flex-1 truncate text-(--combobox-placeholder)">{placeholder}</span>
                    ) : (
                        <span className="min-w-0 flex-1 truncate">{selected.label}</span>
                    )}
                    <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-(--combobox-icon)" />
                </span>
            </button>
            {name === undefined ? null : <input type="hidden" name={name} value={value ?? ''} />}
            <div
                ref={popupRef}
                popover="manual"
                role="presentation"
                style={style}
                onBlur={onFocusOut}
                onMouseDown={(event) => {
                    // Clicking an option keeps focus where it is (the trigger or the search field).
                    if (event.target !== searchRef.current) event.preventDefault();
                }}
                className={cx(
                    'fixed inset-auto m-0 w-max max-w-[min(24rem,calc(100vw-1rem))] flex-col overflow-hidden p-0 open:flex',
                    'rounded-(--combobox-popup-radius) border border-(--combobox-popup-border) bg-(--combobox-popup-bg) text-(--combobox-popup-text) shadow-(--combobox-popup-shadow)',
                    'motion-safe:animate-[ptbk-combobox-enter_var(--motion-enter)_var(--ease-enter)]',
                )}
            >
                {searchable ? (
                    <div className="flex items-center gap-2 border-b border-(--combobox-separator) px-3">
                        <Search aria-hidden="true" className="size-4 shrink-0 text-(--combobox-icon)" />
                        <input
                            ref={searchRef}
                            type="text"
                            role="combobox"
                            aria-autocomplete="list"
                            aria-expanded={open}
                            aria-controls={listboxId}
                            aria-activedescendant={activeId}
                            aria-label={ariaLabelledBy === undefined ? popupLabel : undefined}
                            aria-labelledby={ariaLabelledBy}
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={searchPlaceholder}
                            value={query}
                            onChange={(event) => {
                                const next = event.target.value;
                                setQuery(next);
                                setActiveIndex(enabledFrom(filterOptions(options, next), 0, 1));
                            }}
                            onKeyDown={onOpenKeyDown}
                            className="min-h-9 w-full min-w-0 bg-transparent text-sm text-(--combobox-popup-text) outline-none placeholder:text-(--combobox-placeholder)"
                        />
                    </div>
                ) : null}
                <div
                    ref={listRef}
                    id={listboxId}
                    role="listbox"
                    aria-label={ariaLabelledBy === undefined ? popupLabel : undefined}
                    aria-labelledby={ariaLabelledBy}
                    className="max-h-72 scroll-py-1 overflow-y-auto p-1 empty:hidden"
                >
                    {visible.map((option, index) => (
                        // Options are reached through aria-activedescendant; the keys live on the trigger or search field.
                        // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                        <div
                            key={option.value}
                            id={optionId(index)}
                            role="option"
                            tabIndex={-1}
                            aria-selected={option.value === value}
                            aria-disabled={option.disabled === true ? true : undefined}
                            data-active={index === activeIndex ? '' : undefined}
                            onPointerMove={() => {
                                if (option.disabled !== true) setActiveIndex(index);
                            }}
                            onClick={() => {
                                commit(index, true);
                            }}
                            className={cx(
                                'flex min-h-8 cursor-pointer items-center gap-2 rounded-(--combobox-option-radius) px-2 py-1.5 text-sm',
                                'data-active:bg-(--combobox-option-active)',
                                option.disabled === true && 'cursor-not-allowed opacity-50',
                            )}
                        >
                            {option.leading === undefined ? null : (
                                <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
                                    {option.leading}
                                </span>
                            )}
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate">{option.label}</span>
                                {option.description === undefined ? null : (
                                    <span className="truncate text-xs text-(--combobox-muted)">
                                        {option.description}
                                    </span>
                                )}
                            </span>
                            <Check
                                aria-hidden="true"
                                className={cx(
                                    'size-4 shrink-0 text-(--combobox-check)',
                                    option.value !== value && 'invisible',
                                )}
                            />
                        </div>
                    ))}
                </div>
                <div aria-live="polite">
                    {visible.length === 0 ? (
                        <p className="px-3 py-2 text-sm text-(--combobox-muted)">{messages.noResults()}</p>
                    ) : null}
                </div>
            </div>
        </>
    );
}
