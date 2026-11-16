import type { Activity } from '@ptbk/engine-api';

import { ActivityLine } from '../entities/activity-line';
import type { ActivityOutcome } from '../entities/activity-line';
import { EntityChip } from '../entities/entity-chip';
import { m } from '../../paraglide/messages';

type TriggerActivity = Extract<Activity, { readonly kind: `trigger.${string}` }>;

function isTriggerActivity(activity: Activity): activity is TriggerActivity {
    return activity.kind.startsWith('trigger.');
}

/** One line per `trigger.*` kind (v1); the trigger's name is typed by a member and stays text. */
export function triggerActivitySummary(activity: Activity): string {
    if (!isTriggerActivity(activity)) return activity.kind;
    switch (activity.kind) {
        case 'trigger.fired':
            return m.trigger_activity_fired({ name: activity.name });
        case 'trigger.failed':
            return m.trigger_activity_failed({ name: activity.name });
        case 'trigger.paused':
            return m.trigger_activity_paused({ name: activity.name });
        case 'trigger.resumed':
            return m.trigger_activity_resumed({ name: activity.name });
    }
}

function triggerOutcome(activity: TriggerActivity): ActivityOutcome {
    switch (activity.kind) {
        case 'trigger.fired':
            return { tone: 'info', label: m.activity_outcome_fired() };
        case 'trigger.failed':
            return { tone: 'danger', label: m.activity_outcome_failed() };
        case 'trigger.paused':
            return { tone: 'neutral', label: m.activity_outcome_paused() };
        case 'trigger.resumed':
            return { tone: 'success', label: m.activity_outcome_resumed() };
    }
}

/** A trigger event as an activity line: the trigger and, for a fire, the run it started, as chips. */
export function TriggerActivityItem({ activity }: { readonly activity: Activity }) {
    if (!isTriggerActivity(activity)) return null;
    const runId = activity.kind === 'trigger.fired' ? activity.runId : null;
    const error = activity.kind === 'trigger.failed' ? activity.error : null;
    return (
        <ActivityLine
            activity={activity}
            description={
                <>
                    <EntityChip kind="trigger" id={activity.triggerId} name={activity.name} />
                    {runId === null ? null : <EntityChip kind="run" id={runId} name={m.activity_run_chip()} />}
                </>
            }
            outcome={triggerOutcome(activity)}
            facts={error?.summary ?? null}
        />
    );
}
