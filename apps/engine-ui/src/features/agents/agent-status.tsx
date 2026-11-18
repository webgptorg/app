import type { AgentId } from '@ptbk/engine-api';
import { RelativeTime, Skeleton, StatusDot, StatusPill } from '@ptbk/ui';
import type { StatusTone } from '@ptbk/ui';
import type { ReactNode } from 'react';

import { cx } from '../../app/cx';
import { formatClock, useElapsedMs } from '../chat/references/elapsed';
import { m } from '../../paraglide/messages';
import { isWorking } from './agent-activity';
import type { AgentActivity } from './agent-activity';
import { stateLabel } from './agent-badges';
import { AgentLiveState } from './agent-live-state';
import type { AgentLiveStatus } from './agent-live-state';

export type AgentStatusKind = 'working' | 'needs-you' | 'waiting' | 'stopped' | 'failed' | 'idle' | 'unknown';

export interface AgentStatus {
    readonly kind: AgentStatusKind;
    readonly tone: StatusTone;
    readonly label: string;
}

/**
 * One status for an agent wherever it shows (card, panel, table, header, overview), from both sources, so no two
 * views disagree:
 * 1. **Working** while it writes a reply, runs a task or a run (the page's lists), or its run state says so;
 * 2. **Stopped** or **Failed / Error** as the run state reports them;
 * 3. **Needs you** while it waits for the User to answer one of its questions;
 * 4. **Waiting** when the run state has only queued work;
 * 5. **Idle** otherwise, also when the engine reports no run state at all: the page's lists then decide alone.
 *
 * Unknown only for a run state this UI does not know (a newer engine), with its raw value. `null` while the run state
 * is still loading and the lists show no work, so a view waits instead of flashing Idle.
 */
export function agentStatus(live: AgentLiveStatus, activity: AgentActivity): AgentStatus | null {
    const state = live.kind === 'state' ? live.state : null;
    if (isWorking(activity) || state === 'working' || state === 'running') {
        return { kind: 'working', tone: 'live', label: m.agent_state_working() };
    }
    if (live.kind === 'pending') return null;
    if (state === 'stopped') return { kind: 'stopped', tone: 'warning', label: stateLabel('stopped') };
    if (state === 'failed' || state === 'error') return { kind: 'failed', tone: 'danger', label: stateLabel(state) };
    if (activity.questions > 0) return { kind: 'needs-you', tone: 'warning', label: m.chat_needs_you() };
    switch (state) {
        case null:
        case 'idle':
            return { kind: 'idle', tone: 'neutral', label: stateLabel('idle') };
        case 'waiting':
            return { kind: 'waiting', tone: 'waiting', label: stateLabel('waiting') };
        default:
            return { kind: 'unknown', tone: 'neutral', label: m.agent_state_unknown_value({ value: state }) };
    }
}

/** "2 chats, 1 task" for an agent at work; nothing otherwise. */
export function workSummary(activity: AgentActivity): string | null {
    const chats = new Set(activity.working.map(({ chat }) => chat.id)).size;
    // A run of a task or a chat reply is already counted as that task or reply.
    const runs = activity.runs.filter((run) => (run.taskId ?? null) === null && run.chatId === null).length;
    const parts: string[] = [];
    if (chats > 0) parts.push(m.agents_card_chats({ count: chats }));
    if (activity.tasks.length > 0) parts.push(m.agents_card_tasks({ count: activity.tasks.length }));
    if (runs > 0) parts.push(m.agents_card_runs({ count: runs }));
    return parts.length === 0 ? null : parts.join(', ');
}

/** When its current work started: the earliest reply or run in view, for the card's timer. */
export function workingSince(activity: AgentActivity): string | null {
    const starts = [
        ...activity.working.map(({ working }) => working.startedAt),
        ...activity.runs.flatMap((run) => (run.startedAt === null ? [] : [run.startedAt])),
    ].toSorted();
    return starts[0] ?? null;
}

function Elapsed({ since }: { readonly since: string }) {
    const elapsed = useElapsedMs(since);
    return elapsed === null ? null : <>{formatClock(elapsed)}</>;
}

/** When the agent last spoke in a thread in view: "last active 3 hours ago". */
export function LastActive({ activity }: { readonly activity: AgentActivity }) {
    if (activity.lastActiveAt === null) return null;
    return (
        <>
            {m.agents_card_last_active()} <RelativeTime value={new Date(activity.lastActiveAt)} />
        </>
    );
}

interface AgentStatusProps {
    readonly agentId: AgentId;
    readonly activity: AgentActivity;
}

/** The status as a pill: the header, the table, the panel and the overview's details. */
export function AgentStatusPill({
    agentId,
    activity,
    variant = 'soft',
}: AgentStatusProps & { readonly variant?: 'soft' | 'quiet' }) {
    return (
        <AgentLiveState agentId={agentId}>
            {(live) => {
                const status = agentStatus(live, activity);
                if (status === null) return <Skeleton shape="text" className="h-5 w-16" />;
                return (
                    <StatusPill tone={status.tone} variant={variant}>
                        {status.label}
                    </StatusPill>
                );
            }}
        </AgentLiveState>
    );
}

/**
 * The status as a light line: "Working · 2 chats, 1 task", else the state alone, with "· last active 3 hours ago"
 * where there is room for it (the panel). Tabular figures.
 */
export function AgentStatusLine({
    agentId,
    activity,
    withLastActive = false,
    className,
    withTime = false,
}: AgentStatusProps & {
    readonly withLastActive?: boolean;
    readonly className?: string;
    /** Adds how long it has worked ("0:14") or when it was last active ("3 hours ago"), for the card. */
    readonly withTime?: boolean;
}) {
    return (
        <AgentLiveState agentId={agentId}>
            {(live) => {
                const status = agentStatus(live, activity);
                if (status === null) return <Skeleton shape="text" className="h-4 w-20" />;
                const summary = status.kind === 'working' ? workSummary(activity) : null;
                let detail: ReactNode = summary;
                if (summary === null && withLastActive && activity.lastActiveAt !== null) {
                    detail = <LastActive activity={activity} />;
                }
                let time: ReactNode = null;
                if (withTime) {
                    const since = status.kind === 'working' ? workingSince(activity) : null;
                    if (since !== null) time = <Elapsed since={since} />;
                    else if (status.kind !== 'working' && activity.lastActiveAt !== null) {
                        time = <RelativeTime value={new Date(activity.lastActiveAt)} />;
                    }
                }
                return (
                    <span
                        className={cx(
                            'flex min-w-0 items-center gap-1.5 text-xs text-text-muted tabular-nums',
                            className,
                        )}
                    >
                        <StatusDot tone={status.tone} />
                        <span className="truncate">
                            <span className={status.tone === 'neutral' ? undefined : 'font-medium text-text'}>
                                {status.label}
                            </span>
                            {detail === null ? null : <span> · {detail}</span>}
                            {time === null ? null : <span> · {time}</span>}
                        </span>
                    </span>
                );
            }}
        </AgentLiveState>
    );
}
