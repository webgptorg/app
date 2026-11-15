import type { Activity } from '@ptbk/engine-api';

import { ActivityLine } from '../entities/activity-line';
import type { ActivityOutcome } from '../entities/activity-line';
import { m } from '../../paraglide/messages';

type EngineActivity = Extract<Activity, { readonly kind: `engine.${string}` }>;

function isEngineActivity(activity: Activity): activity is EngineActivity {
    return activity.kind.startsWith('engine.');
}

/** One line per `engine.*` kind (v1). */
export function engineActivitySummary(activity: Activity): string {
    if (!isEngineActivity(activity)) return activity.kind;
    switch (activity.kind) {
        case 'engine.update-available':
            return m.engine_activity_update_available({ version: activity.version });
        case 'engine.updated':
            return m.engine_activity_updated({ from: activity.fromVersion, to: activity.toVersion });
        case 'engine.relay-disconnected':
            return m.engine_activity_relay_disconnected({ relay: activity.relay });
    }
}

function engineOutcome(activity: EngineActivity): ActivityOutcome {
    switch (activity.kind) {
        case 'engine.update-available':
            return { tone: 'info', label: m.activity_outcome_update_available() };
        case 'engine.updated':
            return { tone: 'success', label: m.activity_outcome_updated() };
        case 'engine.relay-disconnected':
            return { tone: 'warning', label: m.activity_outcome_relay_disconnected() };
    }
}

/** An engine event as an activity line: what happened in words, with its outcome. Updates and relays live in Security. */
export function EngineActivityItem({ activity }: { readonly activity: Activity }) {
    if (!isEngineActivity(activity)) return null;
    return (
        <ActivityLine
            activity={activity}
            description={<span className="min-w-0 break-words">{engineActivitySummary(activity)}</span>}
            outcome={engineOutcome(activity)}
        />
    );
}
