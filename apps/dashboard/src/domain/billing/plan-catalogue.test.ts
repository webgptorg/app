import { describe, expect, it } from 'vitest';

import { TEST_PLANS } from '../../testing/billing-fixtures';
import { createPlanCatalogue, planCatalogueSchema } from './plan-catalogue';

const [starter, scale] = TEST_PLANS.plans;

function issues(input: unknown): readonly string[] {
    const result = planCatalogueSchema.safeParse(input);
    return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('plan catalogue', () => {
    it('parses a catalogue and finds plans by ID and by Stripe price', () => {
        const catalogue = createPlanCatalogue(planCatalogueSchema.parse(TEST_PLANS));
        expect(catalogue.none).toEqual({
            id: 'none',
            name: null,
            price: null,
            stripeProductId: null,
            stripePriceId: null,
            features: [],
            quotas: { 'engines.max': 0, 'custom-domains.max': 0 },
        });
        expect(catalogue.plans.map((plan) => plan.id)).toEqual(['starter', 'scale']);
        expect(catalogue.byId('scale')?.quotas['engines.max']).toBeNull();
        expect(catalogue.byId('none')).toBeNull();
        expect(catalogue.byId('enterprise')).toBeNull();
        expect(catalogue.byPriceId(starter.stripePriceId)?.id).toBe('starter');
        expect(catalogue.byPriceId('price_unknown')).toBeNull();
        expect(Object.isFrozen(catalogue.plans[0]?.features)).toBe(true);
        expect(Object.isFrozen(catalogue.none.quotas)).toBe(true);
        expect(catalogue.byId('starter')?.price).toEqual({ amount: '12', currency: 'EUR', interval: 'month' });
        expect(Object.isFrozen(catalogue.byId('starter')?.price)).toBe(true);
        expect(Object.isFrozen(catalogue.byId('starter')?.name)).toBe(true);
        expect(catalogue.byId('scale')).toMatchObject({ name: { en: 'Scale', cs: 'Růst' }, price: null });
    });

    it('requires a name in every locale and checks a stated price', () => {
        expect(issues({ ...TEST_PLANS, plans: [{ ...starter, name: undefined }] })).toEqual(['plans.0.name']);
        expect(issues({ ...TEST_PLANS, plans: [{ ...starter, name: { en: 'Starter' } }] })).toEqual([
            'plans.0.name.cs',
        ]);
        expect(issues({ ...TEST_PLANS, plans: [{ ...starter, name: { en: ' ', cs: 'Začátek' } }] })).toEqual([
            'plans.0.name.en',
        ]);
        expect(issues({ ...TEST_PLANS, plans: [{ ...starter, name: { ...starter.name, de: 'Anfang' } }] })).toEqual([
            'plans.0.name',
        ]);
        for (const amount of ['29.5', '29.50', '0', '1200']) {
            expect(issues({ ...TEST_PLANS, plans: [{ ...starter, price: { ...starter.price, amount } }] })).toEqual([]);
        }
        for (const amount of ['-1', '1e3', '29.999', '029', '29.', '', '12345678']) {
            expect(issues({ ...TEST_PLANS, plans: [{ ...starter, price: { ...starter.price, amount } }] })).toEqual([
                'plans.0.price.amount',
            ]);
        }
        expect(
            issues({ ...TEST_PLANS, plans: [{ ...starter, price: { ...starter.price, currency: 'eur' } }] }),
        ).toEqual(['plans.0.price.currency']);
        expect(
            issues({ ...TEST_PLANS, plans: [{ ...starter, price: { ...starter.price, interval: 'week' } }] }),
        ).toEqual(['plans.0.price.interval']);
    });

    it('rejects duplicate plan IDs and duplicate price IDs', () => {
        expect(issues({ ...TEST_PLANS, plans: [starter, { ...scale, id: 'starter' }] })).toEqual(['plans.1.id']);
        expect(issues({ ...TEST_PLANS, plans: [starter, { ...scale, stripePriceId: starter.stripePriceId }] })).toEqual(
            ['plans.1.stripePriceId'],
        );
    });

    it('rejects an unknown feature or quota, a missing quota and a repeated feature', () => {
        expect(issues({ ...TEST_PLANS, plans: [{ ...starter, features: ['members.invite'] }] })).toEqual([
            'plans.0.features.0',
        ]);
        expect(
            issues({ ...TEST_PLANS, plans: [{ ...starter, quotas: { ...starter.quotas, 'members.max': 3 } }] }),
        ).toEqual(['plans.0.quotas']);
        expect(issues({ ...TEST_PLANS, plans: [{ ...starter, quotas: { 'engines.max': 1 } }] })).toEqual([
            'plans.0.quotas.custom-domains.max',
        ]);
        expect(
            issues({ ...TEST_PLANS, none: { ...TEST_PLANS.none, features: ['engines.create', 'engines.create'] } }),
        ).toEqual(['none.features']);
    });

    it('requires the none plan and reserves its ID', () => {
        expect(issues({ plans: TEST_PLANS.plans })).toEqual(['none']);
        expect(issues({ ...TEST_PLANS, plans: [{ ...starter, id: 'none' }] })).toEqual(['plans.0.id']);
    });

    it('requires Stripe product and price IDs on paid plans, and nothing else', () => {
        expect(issues({ ...TEST_PLANS, plans: [{ ...starter, stripePriceId: '<staging-price-id>' }] })).toEqual([
            'plans.0.stripePriceId',
        ]);
        expect(issues({ ...TEST_PLANS, plans: [{ ...starter, description: 'Starter' }] })).toEqual(['plans.0']);
        expect(
            issues({ ...TEST_PLANS, plans: [{ ...starter, quotas: { ...starter.quotas, 'engines.max': -1 } }] }),
        ).toEqual(['plans.0.quotas.engines.max']);
    });
});
