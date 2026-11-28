import { z } from 'zod';

/**
 * What a plan can switch on or cap (ADR 0017). Closed lists: adding one is a code change, so a plan catalogue that
 * names anything else fails to parse. The rest of the dashboard asks for these, never for a plan.
 */
export const FEATURES = ['engines.create'] as const;
export const featureSchema = z.enum(FEATURES);
export type Feature = z.infer<typeof featureSchema>;

export const QUOTAS = ['engines.max', 'custom-domains.max'] as const;
export const quotaSchema = z.enum(QUOTAS);
export type Quota = z.infer<typeof quotaSchema>;

/**
 * Limits on a meter's count (ADR 0025): `<meter>.max` for the whole organization, `<meter>.per-project.max` for each
 * project. The projects meter's is `engines.max`. A plan that leaves one out is unlimited, so adding one breaks no
 * configuration.
 */
export const METER_QUOTAS = [
    'agents.max',
    'agents.per-project.max',
    'members.max',
    'members.per-project.max',
    'people.max',
] as const;
export type MeterQuota = (typeof METER_QUOTAS)[number];

/** Whether going over a plan's limit stops something new from being created, or only says so (ADR 0025). */
export const OVER_LIMIT_MODES = ['block', 'warn'] as const;
export const overLimitSchema = z.enum(OVER_LIMIT_MODES);
export type OverLimit = z.infer<typeof overLimitSchema>;

/** `none` is the plan of an organization without a live subscription. */
export const planIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

export const NONE_PLAN_ID = 'none';

const planNameTextSchema = z.string().trim().min(1).max(48);

/**
 * A plan's name in every locale the SPA speaks. Plans are configuration (ADR 0017), so their names are too: a new plan
 * needs no message in the catalogues. The SPA indexes it by its locale, so adding a locale fails to compile until the
 * schema names it.
 */
export const planNameSchema = z.strictObject({ en: planNameTextSchema, cs: planNameTextSchema });
export type PlanName = z.infer<typeof planNameSchema>;

export const PLAN_INTERVALS = ['month', 'year'] as const;

/**
 * What a plan's Stripe price charges, for display only: Checkout charges the Stripe price itself. A Stripe price's
 * amount and interval never change, so this stays true as long as it was copied from the price `stripePriceId` names.
 * The amount is a decimal string in the currency's major unit, so it never becomes a float.
 */
export const planPriceSchema = z.strictObject({
    amount: z.string().regex(/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    interval: z.enum(PLAN_INTERVALS),
});
export type PlanPrice = z.infer<typeof planPriceSchema>;

/** An organization's billing state, mapped from the provider's subscription status (D-07). */
export const billingStatusSchema = z.enum(['none', 'active', 'trialing', 'past_due', 'unpaid', 'canceled']);
export type BillingStatus = z.infer<typeof billingStatusSchema>;

/** The states a platform admin follows up on by hand; nothing is suspended automatically. */
export const PROBLEM_STATUSES = ['past_due', 'unpaid', 'canceled'] as const satisfies readonly BillingStatus[];
export const problemStatusSchema = z.enum(PROBLEM_STATUSES);

/**
 * Where Checkout sends the browser back: `/billing`, or `/engines/new` when the plan step there started it (D-10). An
 * allowlist, so no request can name a return URL of its own.
 */
export const CHECKOUT_RETURN_PAGES = ['billing', 'engines-new'] as const;
export const checkoutReturnPageSchema = z.enum(CHECKOUT_RETURN_PAGES);
export type CheckoutReturnPage = z.infer<typeof checkoutReturnPageSchema>;

/** The page's path, without the `?checkout=` the provider adds. */
export const CHECKOUT_RETURN_PATHS: Readonly<Record<CheckoutReturnPage, string>> = {
    billing: '/billing',
    'engines-new': '/engines/new',
};
