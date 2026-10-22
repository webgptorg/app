import type { Activity } from '@ptbk/engine-api';

import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { useRunLinks } from './use-run-links';

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

/** The home feed's card body for a trigger event; a fire links to its run where the engine serves runs and the member may read them. */
export function TriggerActivityItem({ activity }: { readonly activity: Activity }) {
    const linkRuns = useRunLinks();
    if (!isTriggerActivity(activity)) return null;
    const runId = activity.kind === 'trigger.fired' ? activity.runId : null;
    const error = activity.kind === 'trigger.failed' ? activity.error : null;
    return (
        <div className="flex flex-col gap-1 text-sm">
            <p className="break-words">{triggerActivitySummary(activity)}</p>
            {error === null ? null : <p className="break-words text-text-muted">{error.summary}</p>}
            <div className="flex flex-wrap gap-x-4">
                <Link to="/triggers/$triggerId" params={{ triggerId: activity.triggerId }}>
                    {m.trigger_activity_open()}
                </Link>
                {runId !== null && linkRuns ? (
                    <Link to="/runs/$runId" params={{ runId }}>
                        {m.trigger_activity_open_run()}
                    </Link>
                ) : null}
            </div>
        </div>
    );
}
