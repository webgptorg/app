import { Badge, Banner, Button, Card, ErrorState, Skeleton, useLocale as useFormatters } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';

import { m } from '../../../paraglide/messages';
import { apiRoutes } from '../../../shared/api/routes';
import type { BillingView } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { billingQuery, dataOrThrow } from '../../api/queries';
import { useSession } from '../session/use-session';
import { useLocale } from '../../i18n/locale';
import { planNameText, STATUS_LABELS, STATUS_TONES } from './billing-labels';
import { EntitlementList, PlanOfferList, useRedirectMutation } from './plan-offers';

export type CheckoutReturn = 'success' | 'cancel';

const MANAGE_PERMISSION = 'billing.manage';

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
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
                <dt className="text-text-muted">{m.billing_plan_label()}</dt>
                <dd>
                    <Badge tone={billing.planName === null ? 'neutral' : 'accent'}>
                        {planNameText(billing.planName, locale)}
                    </Badge>
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

function PlansCard(props: { readonly billing: BillingView }) {
    return (
        <Card title={m.billing_plans_title()}>
            <p className="text-sm text-text-muted">{m.billing_plans_body()}</p>
            <PlanOfferList
                plans={props.billing.plans}
                trialAvailable={props.billing.trialAvailable}
                returnTo="billing"
            />
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
                    {canManage && billing.data.canSubscribe ? <PlansCard billing={billing.data} /> : null}
                </>
            )}
        </div>
    );
}
