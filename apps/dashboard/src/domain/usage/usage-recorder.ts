import { newUsageEventId } from '../ids';
import type { Clock } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { Random } from '../ports/random';
import { usageEventSchema, type UsageEvent, type UsageEventRow } from './usage-event';
import type { UsageStore } from './usage-store';

/**
 * Records usage events, best effort: `record` never rejects, so a failed write never fails or slows the request that
 * caused it (callers hand it to `waitUntil`). A failure is one log line without content, and the events are dropped.
 */
export interface UsageRecorder {
    record(events: readonly UsageEvent[]): Promise<void>;
}

export interface UsageRecorderDeps {
    readonly store: Pick<UsageStore, 'insertEvents'>;
    readonly clock: Clock;
    readonly random: Random;
    readonly logger: Logger;
}

export function createUsageRecorder(deps: UsageRecorderDeps): UsageRecorder {
    return {
        async record(events) {
            if (events.length === 0) {
                return;
            }
            try {
                const occurredAt = deps.clock.nowMs();
                const rows: UsageEventRow[] = [];
                for (const [position, input] of events.entries()) {
                    const parsed = usageEventSchema.safeParse(input);
                    if (!parsed.success) {
                        deps.logger.warn('usage.event-refused', { position });
                        continue;
                    }
                    const event = parsed.data;
                    rows.push({
                        id: newUsageEventId(deps.random),
                        occurredAt,
                        event: event.event,
                        orgId: event.orgId,
                        userId: event.userId,
                        engineId: event.engineId,
                        props: JSON.stringify(event.props),
                    });
                }
                if (rows.length > 0) {
                    await deps.store.insertEvents(rows);
                }
            } catch (error) {
                deps.logger.warn('usage.record-failed', {
                    error: error instanceof Error ? error.name : 'unknown',
                    events: events.length,
                });
            }
        },
    };
}
