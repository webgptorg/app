import type { BadgeTone } from '@ptbk/ui';

import { m } from '../../../paraglide/messages';
import type { Locale } from '../../../paraglide/runtime';
import type { BillingStatus, Feature, PlanName, PlanPrice, Quota } from '../../../shared/billing';

// Records over the closed unions: a new feature, quota or status fails to compile until it has a label.

export const STATUS_LABELS: Readonly<Record<BillingStatus, () => string>> = {
    none: () => m.billing_status_none(),
    active: () => m.billing_status_active(),
    trialing: () => m.billing_status_trialing(),
    past_due: () => m.billing_status_past_due(),
    unpaid: () => m.billing_status_unpaid(),
    canceled: () => m.billing_status_canceled(),
};

export const STATUS_TONES: Readonly<Record<BillingStatus, BadgeTone>> = {
    none: 'neutral',
    active: 'success',
    trialing: 'success',
    past_due: 'warning',
    unpaid: 'danger',
    canceled: 'neutral',
};

export const FEATURE_LABELS: Readonly<Record<Feature, () => string>> = {
    'engines.create': () => m.billing_feature_engines_create(),
};

export const QUOTA_LABELS: Readonly<Record<Quota, () => string>> = {
    'engines.max': () => m.billing_quota_engines_max(),
    'custom-domains.max': () => m.billing_quota_custom_domains_max(),
};

/**
 * A quota's value: "Not included" for a limit of 0 that nothing uses, else "Unlimited", the limit, or how much of it is
 * used where the dashboard counts usage. A 0 limit with usage (after a downgrade) still shows the count.
 */
export function quotaValue(limit: number | null, used: number | null): string {
    if (limit === 0 && (used === null || used === 0)) {
        return m.billing_feature_not_included();
    }
    if (used === null) {
        return limit === null ? m.billing_quota_unlimited() : String(limit);
    }
    return limit === null
        ? m.billing_quota_used_unlimited({ used: String(used) })
        : m.billing_quota_used({ used: String(used), limit: String(limit) });
}

/** A plan's name in the current locale; `null` is the `none` plan, which only the message catalogues name. */
export function planNameText(name: PlanName | null, locale: Locale): string {
    return name === null ? m.billing_plan_none() : name[locale];
}

/** "€29.00 per month", or where to see the price when the plan catalogue does not state it. */
export function planPriceText(price: PlanPrice | null, formatCurrency: (amount: string, currency: string) => string) {
    if (price === null) {
        return m.billing_price_at_checkout();
    }
    const amount = formatCurrency(price.amount, price.currency);
    switch (price.interval) {
        case 'month':
            return m.billing_price_per_month({ price: amount });
        case 'year':
            return m.billing_price_per_year({ price: amount });
    }
}
