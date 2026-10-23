import type { Alert, MonitorState, PendingAlert } from './alert-rules';
import { MAX_OUTBOX } from './alert-rules';

/** Deliveries tried per alert, one per cron run, before it is dropped (and counted and logged as dropped). */
export const MAX_DELIVERY_ATTEMPTS = 5;

export interface DeliveryResult {
    readonly id: string;
    readonly delivered: boolean;
}

/** Queues new alerts behind the ones still waiting; past {@link MAX_OUTBOX} the oldest go. */
export function enqueueAlerts(state: MonitorState, alerts: readonly Alert[]): MonitorState {
    if (alerts.length === 0) return state;
    const added = alerts.map((alert, index) => ({
        id: `${String(alert.at)}:${String(index)}:${alert.rule}:${alert.subject}:${alert.state}`,
        alert,
        attempts: 0,
    }));
    return { ...state, outbox: [...state.outbox, ...added].slice(-MAX_OUTBOX) };
}

/**
 * Removes what was delivered; counts a failed attempt for the rest and drops an alert after
 * {@link MAX_DELIVERY_ATTEMPTS}. Results for alerts no longer queued are ignored.
 */
export function settleAlerts(
    state: MonitorState,
    results: readonly DeliveryResult[],
): { readonly state: MonitorState; readonly dropped: readonly PendingAlert[] } {
    const outcomes = new Map(results.map((result) => [result.id, result.delivered]));
    const outbox: PendingAlert[] = [];
    const dropped: PendingAlert[] = [];
    for (const pending of state.outbox) {
        const delivered = outcomes.get(pending.id);
        if (delivered === true) continue;
        if (delivered === undefined) {
            outbox.push(pending);
            continue;
        }
        const next = { ...pending, attempts: pending.attempts + 1 };
        (next.attempts >= MAX_DELIVERY_ATTEMPTS ? dropped : outbox).push(next);
    }
    return { state: { ...state, outbox }, dropped };
}
