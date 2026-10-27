import type { Hono } from 'hono';

import type { BillingService } from '../../domain/billing/billing-service';
import type { PaidPlan } from '../../domain/billing/plan-catalogue';
import { QUOTAS } from '../../shared/billing';
import { apiRoutes, type PlanView } from '../../shared/api/routes';
import type { RouteBinder } from './bind-route';

function planView(plan: PaidPlan): PlanView {
    return {
        id: plan.id,
        name: plan.name,
        price: plan.price,
        features: [...plan.features],
        quotas: QUOTAS.map((quota) => ({ quota, limit: plan.quotas[quota] })),
        trialDays: plan.trialDays,
    };
}

/**
 * D-07's `/api` routes. The organization is always the session's active one, never a request field, so nobody can
 * address another organization's customer or subscription.
 */
export function bindBillingRoutes(
    router: Hono,
    mount: string,
    deps: { readonly billing: BillingService; readonly routes: RouteBinder },
): void {
    const { billing } = deps;
    const bind = deps.routes.bind.bind(deps.routes);

    bind(router, mount, apiRoutes.getBilling, async ({ session }) => {
        const overview = await billing.overview(session.actor.orgId);
        return {
            kind: 'ok',
            body: {
                status: overview.status,
                currentPeriodEnd: overview.currentPeriodEnd,
                cancelAtPeriodEnd: overview.cancelAtPeriodEnd,
                planId: overview.plan.id,
                planName: overview.plan.name,
                hasBillingAccount: overview.hasBillingAccount,
                canSubscribe: overview.canSubscribe,
                trialAvailable: overview.trialAvailable,
                entitlements: { features: [...overview.features], quotas: [...overview.quotas] },
                plans: overview.plans.map(planView),
            },
        };
    });

    bind(router, mount, apiRoutes.billingCheckout, async ({ input, request, session }) => {
        const outcome = await billing.checkout(
            {
                orgId: session.actor.orgId,
                email: session.user.email,
                planId: input.body.planId,
                returnTo: input.body.returnTo ?? 'billing',
            },
            request.signal,
        );
        switch (outcome.kind) {
            case 'ok':
                return { kind: 'ok', body: { url: outcome.url } };
            case 'unknown-plan':
                return { kind: 'problem', status: 400, code: 'unknown-plan' };
            case 'already-subscribed':
                return { kind: 'problem', status: 409, code: 'already-subscribed' };
        }
    });

    bind(router, mount, apiRoutes.billingPortal, async ({ request, session }) => ({
        kind: 'ok',
        body: await billing.portal({ orgId: session.actor.orgId, email: session.user.email }, request.signal),
    }));

    bind(router, mount, apiRoutes.adminBilling, async () => ({
        kind: 'ok',
        body: { organizations: [...(await billing.problemOrganizations())] },
    }));
}
