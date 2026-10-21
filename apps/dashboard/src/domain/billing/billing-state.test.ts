import { describe, expect, it } from 'vitest';

import { billingState, billingStatusFromStripe, isOpenSubscription, usesSubscribedPlan } from './billing-state';

describe('billingStatusFromStripe', () => {
    it.each(['active', 'trialing', 'past_due', 'unpaid', 'canceled'] as const)('keeps %s', (status) => {
        expect(billingStatusFromStripe(status)).toBe(status);
    });

    it.each(['incomplete', 'incomplete_expired', 'paused', 'suspended_by_a_future_api', '', 'ACTIVE'])(
        'maps %j to none, which grants nothing a subscription would',
        (status) => {
            expect(billingStatusFromStripe(status)).toBe('none');
        },
    );
});

describe('billingState', () => {
    it('is none without a subscription or with one whose status mapped to none', () => {
        expect(billingState(null)).toEqual({ kind: 'none' });
        expect(billingState({ status: 'none', currentPeriodEnd: 5 })).toEqual({ kind: 'none' });
    });

    it('carries the period end of a real state', () => {
        expect(billingState({ status: 'past_due', currentPeriodEnd: 5 })).toEqual({
            kind: 'past_due',
            currentPeriodEnd: 5,
        });
    });

    it('uses the subscribed plan while active, trialing or past due, and treats unpaid as still open', () => {
        const uses = (['none', 'active', 'trialing', 'past_due', 'unpaid', 'canceled'] as const).filter((status) =>
            usesSubscribedPlan(billingState({ status, currentPeriodEnd: null })),
        );
        expect(uses).toEqual(['active', 'trialing', 'past_due']);
        const open = (['none', 'active', 'trialing', 'past_due', 'unpaid', 'canceled'] as const).filter(
            isOpenSubscription,
        );
        expect(open).toEqual(['active', 'trialing', 'past_due', 'unpaid']);
    });
});
