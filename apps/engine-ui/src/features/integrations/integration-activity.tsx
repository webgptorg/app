import type { Activity } from '@ptbk/engine-api';

import { useParams } from '@tanstack/react-router';

import { ActivityLine } from '../entities/activity-line';
import type { ActivityOutcome } from '../entities/activity-line';
import { EntityChip } from '../entities/entity-chip';
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

function integrationOutcome(activity: IntegrationActivity): ActivityOutcome {
    switch (activity.kind) {
        case 'integration.connected':
            return { tone: 'success', label: m.activity_outcome_connected() };
        case 'integration.error':
            return { tone: 'danger', label: m.activity_outcome_error() };
        case 'integration.used':
            return { tone: 'neutral', label: m.activity_outcome_used() };
    }
}

/**
 * An integration event as an activity line: the integration as a chip (plain text on its own page, where a link would
 * lead nowhere), the tool a run called and that run, the outcome and the engine's detail on an error.
 */
export function IntegrationActivityItem({ activity }: { readonly activity: Activity }) {
    const openIntegrationId = useParams({ strict: false, select: (params) => params.integrationId });
    if (!isIntegrationActivity(activity)) return null;
    const own = openIntegrationId === activity.integrationId;
    return (
        <ActivityLine
            activity={activity}
            description={
                <>
                    <EntityChip kind="integration" id={own ? null : activity.integrationId} name={activity.name} />
                    {activity.kind === 'integration.used' ? (
                        <>
                            <span className="font-mono text-xs text-text-muted">{activity.toolName}</span>
                            {activity.runId === null ? null : (
                                <EntityChip kind="run" id={activity.runId} name={m.activity_run_chip()} />
                            )}
                        </>
                    ) : null}
                </>
            }
            outcome={integrationOutcome(activity)}
            facts={activity.kind === 'integration.error' ? activity.statusDetail : null}
        />
    );
}
