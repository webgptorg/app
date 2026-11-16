import type { Activity } from '@ptbk/engine-api';
import { useLocale } from '@ptbk/ui';

import { m } from '../../paraglide/messages';
import { formatDuration } from './run-format';
import { ActivityLine } from '../entities/activity-line';
import type { ActivityOutcome } from '../entities/activity-line';
import { EntityChip } from '../entities/entity-chip';
import { runStatusLabel } from './run-status';
import { runOrigin, runSourceLabel } from './run-source';

type RunActivity = Extract<Activity, { readonly kind: `run.${string}` }>;

function isRunActivity(activity: Activity): activity is RunActivity {
    return activity.kind.startsWith('run.');
}

/**
 * One line per `run.*` kind (v1); the card names the agent above it. Details such as the error summary are agent text
 * and stay text.
 */
export function runActivitySummary(activity: Activity): string {
    if (!isRunActivity(activity)) return activity.kind;
    const run = runOrigin(activity.source);
    switch (activity.kind) {
        case 'run.queued':
            return m.run_activity_queued({ run });
        case 'run.started':
            return m.run_activity_started({ run });
        case 'run.completed':
            return m.run_activity_completed({ run });
        case 'run.failed':
            return m.run_activity_failed({ run });
        case 'run.cancelled':
            return m.run_activity_cancelled({ run });
    }
}

function runOutcome(activity: RunActivity): ActivityOutcome {
    switch (activity.kind) {
        case 'run.queued':
            return { tone: 'waiting', label: runStatusLabel('queued') };
        case 'run.started':
            return { tone: 'live', label: runStatusLabel('running') };
        case 'run.completed':
            return { tone: 'success', label: runStatusLabel('completed') };
        case 'run.failed':
            return { tone: 'danger', label: runStatusLabel('failed') };
        case 'run.cancelled':
            return { tone: 'neutral', label: runStatusLabel('cancelled') };
    }
}

/** A run event as an activity line: the agent and the run as chips, its outcome, and what it took or why it failed. */
export function RunActivityItem({ activity }: { readonly activity: Activity }) {
    const locale = useLocale();
    if (!isRunActivity(activity)) return null;
    const usage = activity.kind === 'run.completed' ? activity.usage : null;
    const error = activity.kind === 'run.failed' ? activity.error : null;
    const facts = [
        usage?.durationMs == null ? null : formatDuration(usage.durationMs, (value) => locale.formatNumber(value)),
        usage?.cost == null ? null : locale.formatCurrency(usage.cost.amount, usage.cost.currency),
        error?.summary ?? null,
    ].filter((fact) => fact !== null);
    return (
        <ActivityLine
            activity={activity}
            description={
                <EntityChip
                    kind="run"
                    id={activity.runId}
                    name={m.activity_run_label({ source: runSourceLabel(activity.source) })}
                />
            }
            outcome={runOutcome(activity)}
            facts={facts.length === 0 ? null : facts.join(' · ')}
        />
    );
}
