import { useId } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { cx } from '../../internal/cx';

export interface TabDefinition {
    readonly id: string;
    readonly label: string;
    readonly panel: ReactNode;
    readonly disabled?: boolean;
}

export interface TabsProps {
    /** The tab list's accessible name. */
    readonly label: string;
    readonly selectedId: string;
    /** Controlled, so apps can keep the selected tab in the URL. */
    readonly onSelect: (id: string) => void;
    readonly tabs: readonly TabDefinition[];
    /** `automatic` selects on arrow keys; `manual` only moves focus until Enter or Space. */
    readonly activation?: 'automatic' | 'manual';
}

/** The ARIA tabs pattern: one tab stop for the list, arrows, Home and End between tabs, only the selected panel rendered. */
export function Tabs({ label, selectedId, onSelect, tabs, activation = 'automatic' }: TabsProps) {
    const baseId = useId();
    const enabled = tabs.filter((tab) => tab.disabled !== true);
    const selected = tabs.find((tab) => tab.id === selectedId) ?? enabled[0];
    const tabId = (id: string) => `${baseId}-tab-${id}`;
    const panelId = (id: string) => `${baseId}-panel-${id}`;

    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
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
        <div className="flex flex-col gap-4">
            <div
                role="tablist"
                aria-label={label}
                className="flex gap-1 overflow-x-auto border-b border-(--tabs-border)"
            >
                {tabs.map((tab) => {
                    const isSelected = tab.id === selected?.id;
                    return (
                        <button
                            key={tab.id}
                            type="button"
                            role="tab"
                            id={tabId(tab.id)}
                            aria-selected={isSelected}
                            aria-controls={isSelected ? panelId(tab.id) : undefined}
                            disabled={tab.disabled}
                            tabIndex={isSelected ? 0 : -1}
                            onClick={() => {
                                onSelect(tab.id);
                            }}
                            onKeyDown={(event) => {
                                onKeyDown(event, tab.id);
                            }}
                            className={cx(
                                '-mb-px shrink-0 cursor-pointer border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap',
                                'motion-safe:transition-colors motion-safe:duration-(--motion-state)',
                                'disabled:cursor-not-allowed disabled:opacity-50',
                                isSelected
                                    ? 'border-(--tabs-indicator) text-(--tabs-text-selected)'
                                    : 'border-transparent text-(--tabs-text) hover:enabled:text-(--tabs-text-hover)',
                            )}
                        >
                            {tab.label}
                        </button>
                    );
                })}
            </div>
            {selected === undefined ? null : (
                <div role="tabpanel" id={panelId(selected.id)} aria-labelledby={tabId(selected.id)} tabIndex={0}>
                    {selected.panel}
                </div>
            )}
        </div>
    );
}
