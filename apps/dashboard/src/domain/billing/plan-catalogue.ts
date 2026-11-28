import { z } from 'zod';

import {
    FEATURES,
    featureSchema,
    METER_QUOTAS,
    NONE_PLAN_ID,
    overLimitSchema,
    planIdSchema,
    planNameSchema,
    planPriceSchema,
    QUOTAS,
    type Feature,
    type MeterQuota,
    type OverLimit,
    type PlanName,
    type PlanPrice,
    type Quota,
} from '../../shared/billing';

export interface Plan {
    readonly id: string;
    /** Null only for the `none` plan, whose name the SPA's message catalogues carry. */
    readonly name: PlanName | null;
    /** Null for `none`, and for a paid plan whose configuration does not state its price. */
    readonly price: PlanPrice | null;
    /** Null only for the `none` plan, which nobody subscribes to. */
    readonly stripeProductId: string | null;
    readonly stripePriceId: string | null;
    readonly features: readonly Feature[];
    /** `null` is unlimited. */
    readonly quotas: Readonly<Record<Quota | MeterQuota, number | null>>;
    readonly overLimit: OverLimit;
    /** Days of free trial Checkout grants an organization's first subscription; null for none (and for `none`). */
    readonly trialDays: number | null;
}

/** What a plan grants, and all the entitlements port reads of one. */
export type PlanEntitlements = Pick<Plan, 'features' | 'quotas' | 'overLimit'>;

/** A plan Checkout can sell. */
export interface PaidPlan extends Plan {
    readonly name: PlanName;
    readonly stripeProductId: string;
    readonly stripePriceId: string;
}

/** Plans are configuration (ADR 0017): which Stripe price grants which features and quotas. */
export interface PlanCatalogue {
    /** What an organization without a live subscription gets, including whether it may link an engine at all. */
    readonly none: Plan;
    /** The plans Checkout offers, in order. */
    readonly plans: readonly PaidPlan[];
    byId(planId: string): PaidPlan | null;
    byPriceId(priceId: string): PaidPlan | null;
}

const quotaLimitSchema = z.number().int().nonnegative().max(1_000_000).nullable();

const optionalQuotaLimitSchema = quotaLimitSchema.optional();

// Meter quotas are optional, so configuration written before ADR 0025 parses unchanged; absent is unlimited.
const quotasSchema = z.strictObject({
    ...(Object.fromEntries(QUOTAS.map((quota) => [quota, quotaLimitSchema])) as Record<Quota, typeof quotaLimitSchema>),
    ...(Object.fromEntries(METER_QUOTAS.map((quota) => [quota, optionalQuotaLimitSchema])) as Record<
        MeterQuota,
        typeof optionalQuotaLimitSchema
    >),
});

/** Absent is `block`: what `engines.max` has always done. */
const planOverLimitSchema = overLimitSchema.default('block');

const featuresSchema = z
    .array(featureSchema)
    .max(FEATURES.length)
    .refine((features) => new Set(features).size === features.length, 'duplicate feature');

/** The JSON shape of a plan's grants: `none` in `BILLING_PLANS`, and `BILLING_OFF_PLAN`. */
export const planEntitlementsSchema = z.strictObject({
    features: featuresSchema,
    quotas: quotasSchema,
    overLimit: planOverLimitSchema,
});

const paidPlanSchema = z.strictObject({
    id: planIdSchema.refine((id) => id !== NONE_PLAN_ID, `"${NONE_PLAN_ID}" is reserved`),
    name: planNameSchema,
    price: planPriceSchema.optional(),
    stripeProductId: z.string().regex(/^prod_[A-Za-z0-9]{1,64}$/),
    stripePriceId: z.string().regex(/^price_[A-Za-z0-9]{1,64}$/),
    features: featuresSchema,
    quotas: quotasSchema,
    overLimit: planOverLimitSchema,
    trialDays: z.int().min(1).max(30).optional(),
});

/** The JSON shape of the `BILLING_PLANS` var. */
export const planCatalogueSchema = z
    .strictObject({
        none: planEntitlementsSchema,
        plans: z.array(paidPlanSchema).max(32),
    })
    .superRefine((catalogue, ctx) => {
        const seen = { id: new Set<string>(), stripePriceId: new Set<string>() };
        catalogue.plans.forEach((plan, index) => {
            for (const key of ['id', 'stripePriceId'] as const) {
                if (seen[key].has(plan[key])) {
                    ctx.addIssue({ code: 'custom', path: ['plans', index, key], message: `duplicate ${key}` });
                }
                seen[key].add(plan[key]);
            }
        });
    });

function fullQuotas(parsed: z.output<typeof quotasSchema>): Readonly<Record<Quota | MeterQuota, number | null>> {
    const meterQuotas = Object.fromEntries(METER_QUOTAS.map((quota) => [quota, parsed[quota] ?? null])) as Record<
        MeterQuota,
        number | null
    >;
    return Object.freeze({ ...parsed, ...meterQuotas });
}

export function createPlanEntitlements(parsed: z.output<typeof planEntitlementsSchema>): PlanEntitlements {
    return Object.freeze({
        features: Object.freeze([...parsed.features]),
        quotas: fullQuotas(parsed.quotas),
        overLimit: parsed.overLimit,
    });
}

export function createPlanCatalogue(parsed: z.output<typeof planCatalogueSchema>): PlanCatalogue {
    const freeze = <P extends Plan>(plan: P): P =>
        Object.freeze({
            ...plan,
            name: plan.name === null ? null : Object.freeze({ ...plan.name }),
            price: plan.price === null ? null : Object.freeze({ ...plan.price }),
            features: Object.freeze([...plan.features]),
        });
    const none = freeze({
        id: NONE_PLAN_ID,
        name: null,
        price: null,
        stripeProductId: null,
        stripePriceId: null,
        trialDays: null,
        ...createPlanEntitlements(parsed.none),
    });
    const plans = Object.freeze(
        parsed.plans.map(({ price, trialDays, quotas, ...plan }) =>
            freeze({ ...plan, quotas: fullQuotas(quotas), price: price ?? null, trialDays: trialDays ?? null }),
        ),
    );
    return Object.freeze({
        none,
        plans,
        byId: (planId: string) => plans.find((plan) => plan.id === planId) ?? null,
        byPriceId: (priceId: string) => plans.find((plan) => plan.stripePriceId === priceId) ?? null,
    });
}
