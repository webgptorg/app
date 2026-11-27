import type { StoredEngineStatus, TrackedEngineStatus } from '../status/engine-status';
import type { UsageEvent } from './usage-event';

/**
 * The funnel steps an accepted heartbeat completes: the engine's first heartbeat ever, and its setup going from
 * `pending` to `done`, or arriving `done` with the first heartbeat. A purged status is not a first heartbeat: the engine
 * was seen before the retention purge.
 */
export function heartbeatMilestones(
    stored: StoredEngineStatus | null,
    accepted: TrackedEngineStatus,
): readonly UsageEvent[] {
    const subject = { orgId: accepted.orgId, userId: null, engineId: accepted.engineId };
    const events: UsageEvent[] = [];
    if (stored === null) {
        events.push({
            event: 'engine.first_heartbeat',
            ...subject,
            props: { setup: accepted.payload.setup ?? 'unreported' },
        });
    }
    const wasPending = stored === null || (stored.kind === 'tracked' && stored.payload.setup === 'pending');
    if (wasPending && accepted.payload.setup === 'done') {
        events.push({ event: 'engine.setup_completed', ...subject, props: {} });
    }
    return events;
}
