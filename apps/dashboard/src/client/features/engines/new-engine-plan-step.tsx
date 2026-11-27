import { Banner, ErrorState, Section, Skeleton } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';

import { m } from '../../../paraglide/messages';
import { useApiClient } from '../../api/api-client-context';
import { billingQuery } from '../../api/queries';
import { PlanOfferList } from '../billing/plan-offers';
import type { CheckoutReturn } from './new-engine-page';

/** Step 2 of onboarding.md: without `engines.create`, the plans come first, and Checkout returns here. */
export function NewEnginePlanStep(props: { readonly checkout: CheckoutReturn | undefined }) {
    const api = useApiClient();
    const billing = useQuery(billingQuery(api));
    return (
        <Section title={m.engines_new_plan_title()} divided={false} description={m.engines_new_plan_body()}>
            {props.checkout === 'cancel' ? <Banner tone="info">{m.billing_checkout_cancel()}</Banner> : null}
            {billing.data === undefined ? (
                billing.isError ? (
                    <ErrorState
                        message={m.billing_load_failed()}
                        onRetry={() => void billing.refetch()}
                        retrying={billing.isFetching}
                    />
                ) : (
                    <Skeleton className="h-32 w-full" />
                )
            ) : (
                <PlanOfferList
                    plans={billing.data.plans}
                    trialAvailable={billing.data.trialAvailable}
                    returnTo="engines-new"
                />
            )}
        </Section>
    );
}
