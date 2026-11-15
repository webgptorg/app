import type { ActivityBase } from '@ptbk/engine-api';
import { StatusPill } from '@ptbk/ui';
import type { StatusTone } from '@ptbk/ui';
import type { ReactNode } from 'react';

import { m } from '../../paraglide/messages';
import { EntityChip } from './entity-chip';

export interface ActivityOutcome {
    readonly tone: StatusTone;
    readonly label: string;
}

/**
 * One activity as a table-like line: the agent and what happened as chips and a few words, then quiet facts (cost,
 * duration, a reason) in tabular figures and the outcome as a pill. On a phone the facts and the pill drop to a second
 * line, as table rows do. Every name is engine or member text and renders as text only.
 */
export function ActivityLine({
    activity,
    description,
    outcome,
    facts,
}: {
    /** For its agent: the line leads with the agent's chip when it has one. */
    readonly activity: Pick<ActivityBase, 'agentId' | 'agentName'>;
    readonly description: ReactNode;
    readonly outcome?: ActivityOutcome | undefined;
    readonly facts?: ReactNode;
}) {
    return (
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="flex min-w-0 basis-full flex-wrap items-center gap-x-1.5 gap-y-1 sm:flex-1 sm:basis-auto">
                {activity.agentId === null ? null : (
                    <EntityChip
                        kind="agent"
                        id={activity.agentId}
                        name={activity.agentName ?? m.activity_agent_unnamed()}
                    />
                )}
                {description}
            </span>
            {facts === undefined || facts === null ? null : (
                <span className="min-w-0 truncate text-xs text-text-muted tabular-nums sm:max-w-64">{facts}</span>
            )}
            {outcome === undefined ? null : (
                <StatusPill tone={outcome.tone} className="shrink-0">
                    {outcome.label}
                </StatusPill>
            )}
        </span>
    );
}

/** Words between chips, quiet, so the chips stay what the eye scans. */
export function ActivityWords({ children }: { readonly children: ReactNode }) {
    return <span className="text-text-muted">{children}</span>;
}
