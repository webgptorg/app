import { Badge, Banner, Button, Card, ErrorState, Skeleton, useLocale as useFormatters } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';

import { m } from '../../../paraglide/messages';
import { apiRoutes } from '../../../shared/api/routes';
import type { BillingView, PlanView } from '../../../shared/api/routes';
import { FEATURES } from '../../../shared/billing';
import type { Feature, Quota } from '../../../shared/billing';
import { useApiClient } from '../../api/api-client-context';
import { billingQuery, dataOrThrow, problemCode, queryKeys } from '../../api/queries';
import { useBrowser } from '../../core/browser';
import { useAppMutation } from '../../core/mutations';
import { useSession } from '../session/use-session';
import { FEATURE_LABELS, QUOTA_LABELS, quotaValue, STATUS_LABELS, STATUS_TONES } from './billing-labels';
import { isAllowedRedirect, UnsafeRedirectError } from './billing-redirect';

export type CheckoutReturn = 'success' | 'cancel';

const MANAGE_PERMISSION = 'billing.manage';

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
function useRedirectMutation<Variables>(request: (variables: Variables) => Promise<{ readonly url: string }>) {
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

function CheckoutBanner(props: { readonly checkout: CheckoutReturn | undefined }) {
    switch (props.checkout) {
        case 'success':
            return (
                <Banner tone="success" title={m.billing_checkout_success_title()}>
                    {m.billing_checkout_success_body()}
                </Banner>
            );
        case 'cancel':
            return <Banner tone="info">{m.billing_checkout_cancel()}</Banner>;
        case undefined:
            return null;
    }
}

function periodText(billing: BillingView, formatDate: (value: Date) => string): string | null {
    if (billing.currentPeriodEnd === null) {
        return null;
    }
    const date = formatDate(new Date(billing.currentPeriodEnd));
    if (billing.cancelAtPeriodEnd) {
        return m.billing_period_cancels({ date });
    }
    switch (billing.status) {
        case 'trialing':
            return m.billing_period_trial_ends({ date });
        case 'canceled':
        case 'none':
            return m.billing_period_ended({ date });
        case 'active':
        case 'past_due':
        case 'unpaid':
            return m.billing_period_renews({ date });
    }
}

function PaymentProblemBanner(props: { readonly billing: BillingView }) {
    switch (props.billing.status) {
        case 'past_due':
            return (
                <Banner tone="warning" title={m.billing_past_due_title()}>
                    {m.billing_payment_problem_body()}
                </Banner>
            );
        case 'unpaid':
            return (
                <Banner tone="danger" title={m.billing_unpaid_title()}>
                    {m.billing_payment_problem_body()}
                </Banner>
            );
        case 'none':
        case 'active':
        case 'trialing':
        case 'canceled':
            return null;
    }
}

/** Features and quotas of a plan or of the org itself; `used` appears where the dashboard counts usage. */
function EntitlementList(props: {
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

function SubscriptionCard(props: { readonly billing: BillingView; readonly canManage: boolean }) {
    const { billing } = props;
    const api = useApiClient();
    const formatters = useFormatters();
    const portal = useRedirectMutation(async () => dataOrThrow(await api.call(apiRoutes.billingPortal, {})));
    const period = periodText(billing, (value) => formatters.formatDate(value));
    return (
        <Card
            title={m.billing_subscription_title()}
            actions={
                props.canManage && billing.hasBillingAccount ? (
                    <Button
                        size="sm"
                        loading={portal.isPending}
                        onClick={() => {
                            portal.mutate();
                        }}
                    >
                        {m.billing_manage()}
                        <ExternalLink aria-hidden className="ms-1 size-4" />
                    </Button>
                ) : null
            }
        >
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
                <dt className="text-text-muted">{m.billing_plan_label()}</dt>
                <dd>
                    <Badge tone="accent">{billing.planId}</Badge>
                </dd>
                <dt className="text-text-muted">{m.billing_status_label()}</dt>
                <dd>
                    <Badge tone={STATUS_TONES[billing.status]}>{STATUS_LABELS[billing.status]()}</Badge>
                </dd>
            </dl>
            {period === null ? null : <p className="text-sm">{period}</p>}
            <PaymentProblemBanner billing={billing} />
        </Card>
    );
}

/** One offer with its own Checkout mutation, so the spinner needs no comparison of plan IDs (ADR 0017). */
function PlanOffer(props: {
    readonly plan: PlanView;
    readonly busy: boolean;
    readonly onBusy: (busy: boolean) => void;
}) {
    const { plan, onBusy } = props;
    const api = useApiClient();
    const checkout = useRedirectMutation(async (planId: string) =>
        dataOrThrow(await api.call(apiRoutes.billingCheckout, { body: { planId } })),
    );
    return (
        <li className="flex flex-col gap-3 rounded-control border border-border p-4">
            <Badge tone="accent">{plan.id}</Badge>
            <EntitlementList
                features={plan.features}
                quotas={plan.quotas}
                label={m.billing_plan_includes({ plan: plan.id })}
            />
            <Button
                variant="primary"
                loading={checkout.isPending}
                disabled={props.busy && !checkout.isPending}
                aria-label={m.billing_subscribe_named({ plan: plan.id })}
                onClick={() => {
                    onBusy(true);
                    checkout.mutate(plan.id, {
                        onSettled: () => {
                            onBusy(false);
                        },
                    });
                }}
            >
                {m.billing_subscribe()}
            </Button>
        </li>
    );
}

function PlansCard(props: { readonly plans: readonly PlanView[] }) {
    // One Checkout at a time: the others wait while one is on its way.
    const [busy, setBusy] = useState(false);
    return (
        <Card title={m.billing_plans_title()}>
            <p className="text-sm text-text-muted">{m.billing_plans_body()}</p>
            {props.plans.length === 0 ? (
                <p className="text-sm">{m.billing_plans_empty()}</p>
            ) : (
                <ul className="grid gap-4 sm:grid-cols-2">
                    {props.plans.map((plan) => (
                        <PlanOffer key={plan.id} plan={plan} busy={busy} onBusy={setBusy} />
                    ))}
                </ul>
            )}
        </Card>
    );
}

function BillingSkeleton() {
    return (
        <Card title={m.billing_subscription_title()}>
            <span className="sr-only">{m.loading()}</span>
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-64" />
        </Card>
    );
}

/** `/billing`: the active org's plan, status and entitlements, and the way to Stripe Checkout or the portal. */
export function BillingPage(props: { readonly checkout: CheckoutReturn | undefined }) {
    const api = useApiClient();
    const session = useSession();
    const billing = useQuery(billingQuery(api));
    const canManage = session.activeOrg.permissions.includes(MANAGE_PERMISSION);

    return (
        <div className="flex flex-col gap-6">
            <h1 className="font-display text-2xl font-semibold">{m.billing_title()}</h1>
            <CheckoutBanner checkout={props.checkout} />
            {billing.isPending ? <BillingSkeleton /> : null}
            {billing.isError && billing.data === undefined ? (
                <ErrorState
                    message={m.billing_load_failed()}
                    onRetry={() => void billing.refetch()}
                    retrying={billing.isFetching}
                />
            ) : null}
            {billing.data === undefined ? null : (
                <>
                    <SubscriptionCard billing={billing.data} canManage={canManage} />
                    <Card title={m.billing_entitlements_title()}>
                        <p className="text-sm text-text-muted">{m.billing_entitlements_body()}</p>
                        <EntitlementList
                            features={billing.data.entitlements.features}
                            quotas={billing.data.entitlements.quotas}
                        />
                    </Card>
                    {canManage && billing.data.canSubscribe ? <PlansCard plans={billing.data.plans} /> : null}
                </>
            )}
        </div>
    );
}
