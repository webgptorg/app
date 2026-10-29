import type { Activity } from '@ptbk/engine-api';

import { Link } from '../../app/link';
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

/** The home feed's card body for an engine event, linking to the security panel where updates and relays live. */
export function EngineActivityItem({ activity }: { readonly activity: Activity }) {
    return (
        <div className="flex flex-col gap-1 text-sm">
            <Link to="/security" variant="standalone" className="break-words">
                {engineActivitySummary(activity)}
            </Link>
        </div>
    );
}
