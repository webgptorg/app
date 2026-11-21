import { describe, expect, it } from 'vitest';

import { testOrgId } from '../../testing/billing-fixtures';
import { createTestUsage, USAGE_TEST_NOW_MS as NOW } from '../../testing/test-usage';
import type { UsageStore } from './usage-store';
import { userIdSchema } from '../ids';
import { USAGE_EVENT_NAMES, type UsageEvent } from './usage-event';

function setup(failing?: Pick<UsageStore, 'insertEvents'>) {
    return createTestUsage(failing === undefined ? {} : { store: failing });
}

const orgId = testOrgId();
const userId = userIdSchema.parse('uuuuuuuuuuuuuuuuuuuuuuuuuu');
const signedUp: UsageEvent = { event: 'account.signed_up', orgId, userId, engineId: null, props: { via: 'signup' } };

describe('usage recorder', () => {
    it('writes each event with an ID, the time and its props as JSON', async () => {
        const t = setup();
        await t.recorder.record([
            signedUp,
            { event: 'invite.sent', orgId, userId, engineId: null, props: { role: 'admin', teams: 2 } },
        ]);
        expect(t.store.state.events).toEqual([
            {
                id: expect.stringMatching(/^[a-z2-7]{26}$/) as unknown,
                occurredAt: NOW,
                event: 'account.signed_up',
                orgId,
                userId,
                engineId: null,
                props: '{"via":"signup"}',
            },
            expect.objectContaining({ event: 'invite.sent', props: '{"role":"admin","teams":2}' }),
        ]);
        expect(new Set(t.store.state.events.map((row) => row.id)).size).toBe(2);
    });

    it('writes nothing for no events', async () => {
        const t = setup({ insertEvents: () => Promise.reject(new Error('not expected')) });
        await t.recorder.record([]);
        expect(t.logger.entries).toEqual([]);
    });

    it('refuses free text, unknown props and events, and IDs that are not ours, and keeps the valid ones', async () => {
        const t = setup();
        const smuggled = [
            { ...signedUp, props: { via: 'signup', note: 'my prompt' } },
            { ...signedUp, props: { via: 'hello@example.test' } },
            { ...signedUp, event: 'chat.message' },
            { ...signedUp, userId: 'someone@example.test' },
            { ...signedUp, engineId: 'not-an-engine' },
            { event: 'invite.sent', orgId, userId, engineId: null, props: { role: 'admin', teams: 'Client A' } },
            { event: 'invite.sent', orgId, userId, engineId: null, props: { role: 'admin', teams: 1.5 } },
            { ...signedUp, ip: '198.51.100.1' },
        ] as unknown as UsageEvent[];
        await t.recorder.record([...smuggled, signedUp]);
        expect(t.store.state.events.map((row) => row.props)).toEqual(['{"via":"signup"}']);
        expect(t.logger.entries.filter((entry) => entry.event === 'usage.event-refused')).toHaveLength(smuggled.length);
    });

    it('writes nothing when every event is refused', async () => {
        const t = setup({ insertEvents: () => Promise.reject(new Error('not expected')) });
        await t.recorder.record([{ ...signedUp, props: { via: 'free text' } } as unknown as UsageEvent]);
        expect(t.logger.entries.map((entry) => entry.event)).toEqual(['usage.event-refused']);
    });

    it('never rejects: a failed write is one log line without content', async () => {
        const failures: (() => Promise<void>)[] = [
            () => Promise.reject(new TypeError('D1_ERROR: no such table')),
            () => {
                // A binding may throw something that is not an Error.
                // eslint-disable-next-line @typescript-eslint/only-throw-error
                throw 'D1 down';
            },
        ];
        for (const [index, insertEvents] of failures.entries()) {
            const t = setup({ insertEvents });
            await expect(t.recorder.record([signedUp])).resolves.toBeUndefined();
            expect(t.logger.entries).toEqual([
                {
                    level: 'warn',
                    event: 'usage.record-failed',
                    fields: { error: index === 0 ? 'TypeError' : 'unknown', events: 1 },
                },
            ]);
        }
    });

    it('knows every event by a stable dotted name', () => {
        for (const name of USAGE_EVENT_NAMES) {
            expect(name).toMatch(/^[a-z]+\.[a-z_]+$/);
        }
    });
});
