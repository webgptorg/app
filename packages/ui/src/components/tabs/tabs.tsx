import { Fragment, useId, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { cx } from '../../internal/cx';
import { useScrollEdges } from '../../internal/scroll-edges';

/** A fade where the list hides tabs, so a phone shows there is more to scroll to. */
const FADE_CLASSES = {
    left: '[mask-image:linear-gradient(to_left,#000_calc(100%-var(--tabs-fade)),transparent)]',
    right: '[mask-image:linear-gradient(to_right,#000_calc(100%-var(--tabs-fade)),transparent)]',
    both: '[mask-image:linear-gradient(to_right,transparent,#000_var(--tabs-fade),#000_calc(100%-var(--tabs-fade)),transparent)]',
} as const;

export interface TabDefinition {
    readonly id: string;
    readonly label: string;
    readonly panel: ReactNode;
    readonly disabled?: boolean;
}

/** Everything a tab trigger needs for the ARIA tabs pattern; spread it onto a custom trigger such as a router link. */
export interface TabTriggerProps {
    readonly id: string;
    readonly role: 'tab';
    readonly 'aria-selected': boolean;
    readonly 'aria-controls': string | undefined;
    readonly tabIndex: 0 | -1;
    readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
    readonly className: string;
    readonly children: ReactNode;
}

export interface TabsProps {
    /** The tab list's accessible name. */
    readonly label: string;
    readonly selectedId: string;
    /** Controlled, so apps can keep the selected tab in the URL. */
    readonly onSelect: (id: string) => void;
    readonly tabs: readonly TabDefinition[];
    /** Keep all choices visible by wrapping the list onto additional rows when needed. */
    readonly wrap?: boolean;
    /** `automatic` selects on arrow keys; `manual` only moves focus until Enter or Space. */
    readonly activation?: 'automatic' | 'manual';
    /**
     * Renders each trigger instead of a `<button>`, e.g. as a router link so the URL selects the tab and the link
     * preloads on intent. A custom trigger activates itself on click (a link navigates); arrow keys still move focus
     * and, with `automatic` activation, call `onSelect`.
     */
    readonly renderTab?: (tab: TabDefinition, props: TabTriggerProps) => ReactNode;
    /** Fill the parent flex column's height and give the panel the rest, e.g. for a chat that must fit the screen. */
    readonly fill?: boolean;
}

/** The ARIA tabs pattern: one tab stop for the list, arrows, Home and End between tabs, only the selected panel rendered. */
export function Tabs({
    label,
    selectedId,
    onSelect,
    tabs,
    wrap = false,
    activation = 'automatic',
    renderTab,
    fill = false,
}: TabsProps) {
    const baseId = useId();
    const enabled = tabs.filter((tab) => tab.disabled !== true);
    const selected = tabs.find((tab) => tab.id === selectedId) ?? enabled[0];
    const tabId = (id: string) => `${baseId}-tab-${id}`;
    const panelId = (id: string) => `${baseId}-panel-${id}`;
    const listRef = useRef<HTMLDivElement>(null);
    const edges = useScrollEdges(listRef, '[aria-selected="true"]', selected?.id ?? '');
    const fade = edges.left && edges.right ? 'both' : edges.left ? 'left' : edges.right ? 'right' : null;

    const onKeyDown = (event: KeyboardEvent<HTMLElement>, id: string) => {
        // A button activates on Space natively; a link only on Enter.
        if (renderTab !== undefined && event.key === ' ') {
            event.preventDefault();
            event.currentTarget.click();
            return;
        }
        const currentIndex = enabled.findIndex((tab) => tab.id === id);
        const count = enabled.length;
        let next: number;
        switch (event.key) {
            case 'ArrowRight':
                next = currentIndex + 1;
                break;
            case 'ArrowLeft':
                next = currentIndex - 1;
                break;
            case 'Home':
                next = 0;
                break;
            case 'End':
                next = count - 1;
                break;
            default:
                return;
        }
        event.preventDefault();
        const rtl = getComputedStyle(event.currentTarget.parentElement ?? event.currentTarget).direction === 'rtl';
        if (rtl && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) next = 2 * currentIndex - next;
        const target = enabled[((next % count) + count) % count];
        if (target === undefined) return;
        event.currentTarget.parentElement?.querySelector<HTMLElement>(`#${CSS.escape(tabId(target.id))}`)?.focus();
        if (activation === 'automatic') onSelect(target.id);
    };

    return (
        <div className={cx('flex flex-col gap-4', fill && 'min-h-0 flex-1')}>
            <div
                ref={listRef}
                role="tablist"
                aria-label={label}
                className={cx(
                    'flex shrink-0 gap-1 overflow-x-auto border-b border-(--tabs-border) [scrollbar-width:thin]',
                    wrap && 'flex-wrap',
                    fade !== null && FADE_CLASSES[fade],
                )}
            >
                {tabs.map((tab) => {
                    const isSelected = tab.id === selected?.id;
                    const triggerProps: TabTriggerProps = {
                        id: tabId(tab.id),
                        role: 'tab',
                        'aria-selected': isSelected,
                        'aria-controls': isSelected ? panelId(tab.id) : undefined,
                        tabIndex: isSelected ? 0 : -1,
                        onKeyDown: (event) => {
                            onKeyDown(event, tab.id);
                        },
                        className: cx(
                            '-mb-px shrink-0 cursor-pointer border-b-2 px-2.5 py-2 text-sm font-medium whitespace-nowrap',
                            'motion-safe:transition-colors motion-safe:duration-(--motion-state)',
                            'disabled:cursor-not-allowed disabled:opacity-50',
                            isSelected
                                ? 'border-(--tabs-indicator) text-(--tabs-text-selected)'
                                : 'border-transparent text-(--tabs-text) hover:not-disabled:text-(--tabs-text-hover)',
                        ),
                        children: tab.label,
                    };
                    if (renderTab !== undefined) {
                        return <Fragment key={tab.id}>{renderTab(tab, triggerProps)}</Fragment>;
                    }
                    return (
                        <button
                            key={tab.id}
                            type="button"
                            {...triggerProps}
                            disabled={tab.disabled}
                            onClick={() => {
                                onSelect(tab.id);
                            }}
                        />
                    );
                })}
            </div>
            {selected === undefined ? null : (
                <div
                    role="tabpanel"
                    id={panelId(selected.id)}
                    aria-labelledby={tabId(selected.id)}
                    tabIndex={0}
                    className={cx(fill && 'flex min-h-0 flex-1 flex-col')}
                >
                    {selected.panel}
                </div>
            )}
        </div>
    );
}
