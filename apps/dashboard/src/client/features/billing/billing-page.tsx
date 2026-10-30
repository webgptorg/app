import { Badge, Banner, Button, Card, ErrorState, Skeleton, useLocale as useFormatters } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';

import { m } from '../../../paraglide/messages';
import { apiRoutes } from '../../../shared/api/routes';
import type { BillingView } from '../../../shared/api/routes';
import type { BillingStatus } from '../../../shared/billing';
import { useApiClient } from '../../api/api-client-context';
import { billingQuery, dataOrThrow } from '../../api/queries';
import { useSession } from '../session/use-session';
import { useLocale } from '../../i18n/locale';
import { planNameText, STATUS_LABELS, STATUS_TONES } from './billing-labels';
import { EntitlementList, PlanOfferList, useRedirectMutation } from './plan-offers';

export type CheckoutReturn = 'success' | 'cancel';

const MANAGE_PERMISSION = 'billing.manage';
/** While the webhook has not arrived after Checkout, the page asks again at the link flow's pace. */
const CHECKOUT_POLL_MS = 3000;

/** Back from Checkout the subscription may still be on its way (the webhook), so the wait is mentioned only while it is. */
function CheckoutBanner(props: {
    readonly checkout: CheckoutReturn | undefined;
    readonly status: BillingStatus | null;
}) {
    switch (props.checkout) {
        case 'success':
            return (
                <Banner tone="success" title={m.billing_checkout_success_title()}>
                    {props.status === 'none' ? m.billing_checkout_success_body() : null}
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

function SubscriptionCard(props: { readonly billing: BillingView; readonly canManage: boolean }) {
    const { billing } = props;
    const api = useApiClient();
    const formatters = useFormatters();
    const { locale } = useLocale();
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
            <div className="flex flex-col gap-1">
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-display text-xl font-semibold">{planNameText(billing.planName, locale)}</span>
                    <Badge tone={STATUS_TONES[billing.status]}>{STATUS_LABELS[billing.status]()}</Badge>
                </p>
                {period === null ? null : <p className="text-sm text-text-muted">{period}</p>}
            </div>
            <PaymentProblemBanner billing={billing} />
            <div className="max-w-md">
                <EntitlementList
                    features={billing.entitlements.features}
                    quotas={billing.entitlements.quotas}
                    label={m.billing_entitlements_title()}
                />
            </div>
        </Card>
    );
}

/** Offers on the page itself, each its own box: a card around them would only add a frame. */
function PlanOffers(props: { readonly billing: BillingView; readonly title: string }) {
    return (
        <section aria-labelledby="billing-plans-title" className="flex flex-col gap-4">
            <h2 id="billing-plans-title" className="font-display text-lg font-semibold">
                {props.title}
            </h2>
            <PlanOfferList
                plans={props.billing.plans}
                trialAvailable={props.billing.trialAvailable}
                returnTo="billing"
            />
            <p className="text-sm text-text-muted">{m.billing_plans_body()}</p>
        </section>
    );
}

/** No plan yet: the offers are the page, or for a member who may not choose one, who can. */
function NoPlan(props: { readonly billing: BillingView; readonly canManage: boolean }) {
    return props.canManage ? (
        <PlanOffers billing={props.billing} title={m.billing_none_title()} />
    ) : (
        <p>{m.billing_none_not_allowed()}</p>
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
    const navigate = useNavigate();
    // Shown once: the query leaves the URL, so a reload or a bookmark does not thank again.
    const [checkout] = useState(props.checkout);
    const billing = useQuery({
        ...billingQuery(api),
        refetchInterval: (query) =>
            checkout === 'success' && query.state.data?.status === 'none' ? CHECKOUT_POLL_MS : false,
        refetchIntervalInBackground: false,
    });
    const canManage = session.activeOrg.permissions.includes(MANAGE_PERMISSION);
    const leftCheckout = props.checkout !== undefined;
    useEffect(() => {
        if (leftCheckout) {
            // Only the query changes; a view transition here would cut short the one that brought the page in.
            void navigate({ to: '/billing', search: {}, replace: true, viewTransition: false });
        }
    }, [leftCheckout, navigate]);

    return (
        <div className="flex flex-col gap-6">
            <h1 className="font-display text-2xl font-semibold">{m.billing_title()}</h1>
            <CheckoutBanner checkout={checkout} status={billing.data?.status ?? null} />
            {billing.isPending ? <BillingSkeleton /> : null}
            {billing.isError && billing.data === undefined ? (
                <ErrorState
                    message={m.billing_load_failed()}
                    onRetry={() => void billing.refetch()}
                    retrying={billing.isFetching}
                />
            ) : null}
            {billing.data === undefined ? null : billing.data.status === 'none' ? (
                <NoPlan billing={billing.data} canManage={canManage} />
            ) : (
                <>
                    <SubscriptionCard billing={billing.data} canManage={canManage} />
                    {canManage && billing.data.canSubscribe ? (
                        <PlanOffers billing={billing.data} title={m.billing_plans_title()} />
                    ) : null}
                </>
            )}
        </div>
    );
}
