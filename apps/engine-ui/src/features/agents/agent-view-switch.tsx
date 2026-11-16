import { LayoutGrid, List } from 'lucide-react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';
import { AGENT_VIEWS } from './agent-view';
import type { AgentView } from './agent-view';

const ICONS = { grid: LayoutGrid, table: List } as const;

function viewLabel(view: AgentView): string {
    return view === 'grid' ? m.agents_view_grid() : m.agents_view_table();
}

/** Cards or the table, as two quiet pressed-state buttons; the choice goes to the URL and is remembered. */
export function AgentViewSwitch({
    view,
    onChange,
}: {
    readonly view: AgentView;
    readonly onChange: (view: AgentView) => void;
}) {
    return (
        <div
            role="group"
            aria-label={m.agents_view_label()}
            className="inline-flex gap-0.5 rounded-control bg-hover p-0.5"
        >
            {AGENT_VIEWS.map((option) => {
                const Icon = ICONS[option];
                const pressed = option === view;
                return (
                    <button
                        key={option}
                        type="button"
                        aria-pressed={pressed}
                        title={viewLabel(option)}
                        onClick={() => {
                            if (!pressed) onChange(option);
                        }}
                        className={cx(
                            'inline-flex min-h-8 items-center gap-1.5 rounded-small px-2.5 text-sm',
                            'focus-visible:outline-2 focus-visible:outline-focus',
                            'motion-safe:transition-colors motion-safe:duration-(--motion-state)',
                            // The pressed one sits on the page colour with a hairline, so it reads without hue.
                            pressed
                                ? 'border border-border bg-surface font-medium text-text'
                                : 'border border-transparent text-text-muted hover:text-text',
                        )}
                    >
                        <Icon aria-hidden className="size-4" />
                        <span className="max-sm:sr-only">{viewLabel(option)}</span>
                    </button>
                );
            })}
        </div>
    );
}
