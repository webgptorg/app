import type { Activity } from '@ptbk/engine-api';

import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';

type IntegrationActivity = Extract<Activity, { readonly kind: `integration.${string}` }>;

function isIntegrationActivity(activity: Activity): activity is IntegrationActivity {
    return activity.kind.startsWith('integration.');
}

/** One line per `integration.*` kind (v1). Names and tool names come from the engine and third parties: text only. */
export function integrationActivitySummary(activity: Activity): string {
    if (!isIntegrationActivity(activity)) return activity.kind;
    switch (activity.kind) {
        case 'integration.connected':
            return m.integration_activity_connected({ name: activity.name });
        case 'integration.error':
            return m.integration_activity_error({ name: activity.name });
        case 'integration.used':
            return m.integration_activity_used({ name: activity.name, tool: activity.toolName });
    }
}

/** The card body for an integration event, linking to the integration and, for a tool call, to its run. */
export function IntegrationActivityItem({ activity }: { readonly activity: Activity }) {
    if (!isIntegrationActivity(activity)) return null;
    return (
        <div className="flex flex-col gap-1 text-sm">
            <p className="break-words">{integrationActivitySummary(activity)}</p>
            {activity.kind === 'integration.error' && activity.statusDetail !== null ? (
                <p className="break-words text-text-muted">{activity.statusDetail}</p>
            ) : null}
            <div className="flex flex-wrap gap-x-4 gap-y-1">
                <Link to="/integrations/$integrationId" params={{ integrationId: activity.integrationId }}>
                    {m.integration_activity_open()}
                </Link>
                {activity.kind === 'integration.used' && activity.runId !== null ? (
                    <Link to="/runs/$runId" params={{ runId: activity.runId }}>
                        {m.integration_activity_open_run()}
                    </Link>
                ) : null}
            </div>
        </div>
    );
}
