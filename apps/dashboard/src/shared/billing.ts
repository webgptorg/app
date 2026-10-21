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

/** `none` is the plan of an organization without a live subscription. */
export const planIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

export const NONE_PLAN_ID = 'none';

/** An organization's billing state, mapped from the provider's subscription status (D-07). */
export const billingStatusSchema = z.enum(['none', 'active', 'trialing', 'past_due', 'unpaid', 'canceled']);
export type BillingStatus = z.infer<typeof billingStatusSchema>;

/** The states a platform admin follows up on by hand; nothing is suspended automatically. */
export const PROBLEM_STATUSES = ['past_due', 'unpaid', 'canceled'] as const satisfies readonly BillingStatus[];
export const problemStatusSchema = z.enum(PROBLEM_STATUSES);
