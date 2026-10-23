import { describe, expect, it } from 'vitest';

import { MAX_DELIVERY_ATTEMPTS, enqueueAlerts, settleAlerts } from './alert-outbox';
import type { Alert } from './alert-rules';
import { INITIAL_MONITOR_STATE, MAX_OUTBOX } from './alert-rules';

const alert = (at: number, subject = 'relay-a'): Alert => ({
    rule: 'relay-unreachable',
    subject,
    state: 'firing',
    at,
    detail: { failedChecks: 2 },
});

describe('enqueueAlerts', () => {
    it('queues new alerts behind the waiting ones with distinct ids, and drops the oldest beyond the bound', () => {
        expect(enqueueAlerts(INITIAL_MONITOR_STATE, [])).toBe(INITIAL_MONITOR_STATE);
        const state = enqueueAlerts(enqueueAlerts(INITIAL_MONITOR_STATE, [alert(1)]), [alert(2), alert(2, 'relay-b')]);
        expect(state.outbox.map((pending) => [pending.alert.at, pending.attempts])).toEqual([
            [1, 0],
            [2, 0],
            [2, 0],
        ]);
        expect(new Set(state.outbox.map((pending) => pending.id)).size).toBe(3);
        const full = enqueueAlerts(
            INITIAL_MONITOR_STATE,
            Array.from({ length: MAX_OUTBOX + 2 }, (_, index) => alert(index)),
        );
        expect(full.outbox).toHaveLength(MAX_OUTBOX);
        expect(full.outbox[0]?.alert.at).toBe(2);
    });
});

describe('settleAlerts', () => {
    it('removes delivered alerts, counts failed attempts, keeps unsettled ones, and drops after the last attempt', () => {
        let state = enqueueAlerts(INITIAL_MONITOR_STATE, [alert(1), alert(2), alert(3)]);
        const [first, second, third] = state.outbox.map((pending) => pending.id) as [string, string, string];
        let settled = settleAlerts(state, [
            { id: first, delivered: true },
            { id: second, delivered: false },
            { id: 'gone', delivered: false },
        ]);
        expect(settled.dropped).toEqual([]);
        expect(settled.state.outbox.map((pending) => [pending.id, pending.attempts])).toEqual([
            [second, 1],
            [third, 0],
        ]);
        state = settled.state;
        for (let attempt = 2; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
            settled = settleAlerts(state, [{ id: second, delivered: false }]);
            state = settled.state;
        }
        expect(settled.dropped.map((pending) => [pending.id, pending.attempts])).toEqual([
            [second, MAX_DELIVERY_ATTEMPTS],
        ]);
        expect(state.outbox.map((pending) => pending.id)).toEqual([third]);
    });
});
