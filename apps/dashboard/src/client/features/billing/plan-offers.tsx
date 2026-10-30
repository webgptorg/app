import { Badge, Button, useLocale as useFormatters } from '@ptbk/ui';
import { useState } from 'react';

import { m } from '../../../paraglide/messages';
import { apiRoutes } from '../../../shared/api/routes';
import type { PlanView } from '../../../shared/api/routes';
import { FEATURES } from '../../../shared/billing';
import type { CheckoutReturnPage, Feature, Quota } from '../../../shared/billing';
import { useApiClient } from '../../api/api-client-context';
import { dataOrThrow, problemCode, queryKeys } from '../../api/queries';
import { useBrowser } from '../../core/browser';
import { useAppMutation } from '../../core/mutations';
import { useLocale } from '../../i18n/locale';
import { FEATURE_LABELS, planNameText, planPriceText, QUOTA_LABELS, quotaValue } from './billing-labels';
import { isAllowedRedirect, UnsafeRedirectError } from './billing-redirect';

function billingErrorMessage(error: unknown): string | undefined {
    if (error instanceof UnsafeRedirectError) {
        return m.billing_redirect_refused();
    }
    const code = problemCode(error);
    if (code === 'unknown-plan') {
        return m.billing_unknown_plan();
    }
    return code === 'already-subscribed' ? m.billing_already_subscribed() : undefined;
}

/** Both billing actions end in a top-level navigation to the URL the API names, after checking it once more. */
export function useRedirectMutation<Variables>(request: (variables: Variables) => Promise<{ readonly url: string }>) {
    const browser = useBrowser();
    return useAppMutation<string, Variables>({
        mutationFn: async (variables) => {
            const { url } = await request(variables);
            if (!isAllowedRedirect(url, browser.origin)) {
                throw new UnsafeRedirectError();
            }
            return url;
        },
        // Whatever happened (a plan withdrawn, a subscription started in another tab), the page shows the server's view.
        invalidates: [queryKeys.billing],
        errorMessage: billingErrorMessage,
        onSuccess: (url) => {
            browser.navigate(url);
        },
    });
}

/** Features and quotas of a plan or of the org itself; `used` appears where the dashboard counts usage. */
export function EntitlementList(props: {
    readonly features: readonly Feature[];
    readonly quotas: readonly {
        readonly quota: Quota;
        readonly limit: number | null;
        readonly used?: number | null;
    }[];
    /** Names the list where the surrounding card does not, e.g. one list per plan. */
    readonly label?: string;
}) {
    return (
        <dl
            {...(props.label === undefined ? {} : { 'aria-label': props.label })}
            className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm"
        >
            {FEATURES.map((feature) => {
                const included = props.features.includes(feature);
                return (
                    <div key={feature} className="contents">
                        <dt>{FEATURE_LABELS[feature]()}</dt>
                        <dd>
                            <Badge tone={included ? 'success' : 'neutral'}>
                                {included ? m.billing_feature_included() : m.billing_feature_not_included()}
                            </Badge>
                        </dd>
                    </div>
                );
            })}
            {props.quotas.map(({ quota, limit, used }) => (
                <div key={quota} className="contents">
                    <dt>{QUOTA_LABELS[quota]()}</dt>
                    <dd className="font-medium tabular-nums">{quotaValue(limit, used ?? null)}</dd>
                </div>
            ))}
        </dl>
    );
}

/** One offer with its own Checkout mutation, so the spinner needs no comparison of plan IDs (ADR 0017). */
function PlanOffer(props: {
    readonly plan: PlanView;
    readonly trialAvailable: boolean;
    readonly returnTo: CheckoutReturnPage;
    readonly busy: boolean;
    readonly onBusy: (busy: boolean) => void;
}) {
    const { plan, onBusy } = props;
    const api = useApiClient();
    const formatters = useFormatters();
    const { locale } = useLocale();
    const name = planNameText(plan.name, locale);
    const trialDays = props.trialAvailable ? plan.trialDays : null;
    const checkout = useRedirectMutation(async (planId: string) =>
        dataOrThrow(await api.call(apiRoutes.billingCheckout, { body: { planId, returnTo: props.returnTo } })),
    );
    return (
        <li className="flex flex-col gap-3 rounded-control border border-border bg-(--card-bg) p-4">
            <div className="flex flex-col gap-1">
                <h3 className="font-display text-lg font-semibold">{name}</h3>
                <p className={plan.price === null ? 'text-sm text-text-muted' : 'font-medium tabular-nums'}>
                    {planPriceText(plan.price, (amount, currency) => formatters.formatCurrency(amount, currency))}
                </p>
            </div>
            <EntitlementList
                features={plan.features}
                quotas={plan.quotas}
                label={m.billing_plan_includes({ plan: name })}
            />
            {trialDays === null ? null : <p className="text-sm text-text-muted">{m.billing_trial_note()}</p>}
            <Button
                variant="primary"
                loading={checkout.isPending}
                disabled={props.busy && !checkout.isPending}
                aria-label={
                    trialDays === null
                        ? m.billing_subscribe_named({ plan: name })
                        : m.billing_start_trial_named({ days: String(trialDays), plan: name })
                }
                onClick={() => {
                    onBusy(true);
                    checkout.mutate(plan.id, {
                        onSettled: () => {
                            onBusy(false);
                        },
                    });
                }}
            >
                {trialDays === null ? m.billing_subscribe() : m.billing_start_trial({ days: String(trialDays) })}
            </Button>
        </li>
    );
}

/** The plans Checkout offers; Checkout returns the browser to `returnTo`'s page. */
export function PlanOfferList(props: {
    readonly plans: readonly PlanView[];
    readonly trialAvailable: boolean;
    readonly returnTo: CheckoutReturnPage;
}) {
    // One Checkout at a time: the others wait while one is on its way.
    const [busy, setBusy] = useState(false);
    if (props.plans.length === 0) {
        return <p className="text-sm">{m.billing_plans_empty()}</p>;
    }
    return (
        <ul className="grid gap-4 sm:grid-cols-2">
            {props.plans.map((plan) => (
                <PlanOffer
                    key={plan.id}
                    plan={plan}
                    trialAvailable={props.trialAvailable}
                    returnTo={props.returnTo}
                    busy={busy}
                    onBusy={setBusy}
                />
            ))}
        </ul>
    );
}
