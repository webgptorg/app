import type { ReadTask, ReadTaskOccurrence, TaskState } from '@ptbk/engine-api';
import { StatusPill } from '@ptbk/ui';
import type { StatusTone } from '@ptbk/ui';

import { m } from '../../paraglide/messages';

/** A state this UI does not know yet (a newer engine's) reads as `unknown`, never as an error. */
export type TaskStateValue = ReadTask['state'];

/**
 * The status groups the list filters and sections by. Each holds engine readiness kinds verbatim; the grouping is
 * presentation only and never changes what the engine does or the order it reports.
 */
export const TASK_STATUS_GROUPS = {
    running: ['active'],
    'needs-you': ['awaiting-user'],
    ready: ['ready', 'needs-assignment', 'assigning'],
    blocked: ['blocked', 'failed', 'needs-recovery', 'incompatible'],
    waiting: ['waiting-until', 'waiting-dependency', 'not-ready', 'placeholder'],
    done: ['done'],
    cancelled: ['cancelled'],
    retired: ['retired'],
} as const satisfies Readonly<Record<string, readonly TaskState[]>>;
export type TaskStatusGroup = keyof typeof TASK_STATUS_GROUPS;
export const TASK_STATUS_GROUP_IDS = Object.keys(TASK_STATUS_GROUPS) as TaskStatusGroup[];

export function taskStatusGroupLabel(group: TaskStatusGroup): string {
    switch (group) {
        case 'running':
            return m.task_group_running();
        case 'needs-you':
            return m.task_group_needs_you();
        case 'ready':
            return m.task_group_ready();
        case 'blocked':
            return m.task_group_blocked();
        case 'waiting':
            return m.task_group_waiting();
        case 'done':
            return m.task_group_done();
        case 'cancelled':
            return m.task_group_cancelled();
        case 'retired':
            return m.task_group_retired();
    }
}

/** The list's three sections: what needs a decision now, what comes next, and what is closed. */
export type TaskSection = 'now' | 'upcoming' | 'closed';
export const TASK_SECTIONS: readonly TaskSection[] = ['now', 'upcoming', 'closed'];

export function taskSection(state: TaskStateValue): TaskSection {
    if (state === 'done' || state === 'cancelled' || state === 'retired') return 'closed';
    if ((TASK_STATUS_GROUPS.waiting as readonly string[]).includes(state)) return 'upcoming';
    return 'now';
}

export function taskSectionLabel(section: TaskSection): string {
    switch (section) {
        case 'now':
            return m.tasks_section_now();
        case 'upcoming':
            return m.tasks_section_upcoming();
        case 'closed':
            return m.tasks_section_closed();
    }
}

interface StateLook {
    readonly label: string;
    readonly tone: StatusTone;
}

function lookOf(state: TaskStateValue): StateLook {
    switch (state) {
        case 'active':
            return { label: m.task_state_active(), tone: 'live' };
        case 'awaiting-user':
            return { label: m.task_state_awaiting_user(), tone: 'warning' };
        case 'ready':
            return { label: m.task_state_ready(), tone: 'waiting' };
        case 'needs-assignment':
            return { label: m.task_state_needs_assignment(), tone: 'waiting' };
        case 'assigning':
            return { label: m.task_state_assigning(), tone: 'waiting' };
        case 'needs-recovery':
            return { label: m.task_state_needs_recovery(), tone: 'warning' };
        case 'failed':
            return { label: m.task_state_failed(), tone: 'danger' };
        case 'incompatible':
            return { label: m.task_state_incompatible(), tone: 'danger' };
        case 'blocked':
            return { label: m.task_state_blocked(), tone: 'danger' };
        case 'waiting-until':
            return { label: m.task_state_waiting_until(), tone: 'waiting' };
        case 'waiting-dependency':
            return { label: m.task_state_waiting_dependency(), tone: 'waiting' };
        case 'not-ready':
            return { label: m.task_state_not_ready(), tone: 'waiting' };
        case 'placeholder':
            return { label: m.task_state_placeholder(), tone: 'neutral' };
        case 'done':
            return { label: m.task_state_done(), tone: 'success' };
        case 'cancelled':
            return { label: m.task_state_cancelled(), tone: 'neutral' };
        case 'retired':
            return { label: m.task_state_retired(), tone: 'neutral' };
        case 'unknown':
            return { label: m.task_state_unknown(), tone: 'neutral' };
    }
}

export function taskTone(state: TaskStateValue): StatusTone {
    return lookOf(state).tone;
}

/** The state in words with its dot, never colour alone. */
export function TaskStateBadge({ state, className }: { readonly state: TaskStateValue; readonly className?: string }) {
    const look = lookOf(state);
    return (
        <StatusPill tone={look.tone} {...(className === undefined ? {} : { className })}>
            {look.label}
        </StatusPill>
    );
}

export function taskStateLabel(state: TaskStateValue): string {
    return lookOf(state).label;
}

export function occurrenceStateLabel(state: ReadTaskOccurrence['state']): string {
    switch (state) {
        case 'pending':
            return m.task_occurrence_state_pending();
        case 'running':
            return m.task_occurrence_state_running();
        case 'waiting':
            return m.task_occurrence_state_waiting();
        case 'completed':
            return m.task_occurrence_state_completed();
        case 'failed':
            return m.task_occurrence_state_failed();
        case 'cancelled':
            return m.task_occurrence_state_cancelled();
        case 'interrupted':
            return m.task_occurrence_state_interrupted();
        case 'unknown':
            return m.task_state_unknown();
    }
}

export function occurrenceTone(state: ReadTaskOccurrence['state']): StatusTone {
    if (state === 'completed') return 'success';
    if (state === 'failed' || state === 'interrupted') return 'danger';
    if (state === 'running') return 'live';
    if (state === 'waiting' || state === 'pending') return 'waiting';
    return 'neutral';
}

export function occurrenceReasonLabel(reason: ReadTaskOccurrence['reason']): string {
    switch (reason) {
        case 'first':
            return m.task_occurrence_reason_first();
        case 'repeat':
            return m.task_occurrence_reason_repeat();
        case 'catch-up':
            return m.task_occurrence_reason_catch_up();
        case 'reopen':
            return m.task_occurrence_reason_reopen();
        case 'retry':
            return m.task_occurrence_reason_retry();
        case 'unknown':
            return m.task_state_unknown();
    }
}
