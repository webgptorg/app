import type { Activity } from '@ptbk/engine-api';
import { useLocale } from '@ptbk/ui';

import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { formatDuration } from './run-format';
import { runOrigin } from './run-source';

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

/** The home feed's card body for a run event: its summary is the link to the run. */
export function RunActivityItem({ activity }: { readonly activity: Activity }) {
    const locale = useLocale();
    if (!isRunActivity(activity)) return null;
    const usage = activity.kind === 'run.completed' ? activity.usage : null;
    const error = activity.kind === 'run.failed' ? activity.error : null;
    return (
        <div className="flex flex-col gap-1 text-sm">
            <Link to="/runs/$runId" params={{ runId: activity.runId }} variant="standalone">
                {runActivitySummary(activity)}
            </Link>
            {usage === null ? null : (
                <p className="text-text-muted">
                    {usage.durationMs === null
                        ? null
                        : m.run_activity_duration({
                              duration: formatDuration(usage.durationMs, (value) => locale.formatNumber(value)),
                          })}{' '}
                    {usage.cost === null
                        ? null
                        : m.run_activity_cost({ cost: locale.formatCurrency(usage.cost.amount, usage.cost.currency) })}
                </p>
            )}
            {error === null ? null : <p className="break-words text-text-muted">{error.summary}</p>}
        </div>
    );
}
