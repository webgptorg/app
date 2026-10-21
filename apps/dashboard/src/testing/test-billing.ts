import {
    createFakeBillingProvider,
    createFakeBillingState,
    type FakeBillingState,
} from '../adapters/billing/fake-billing-provider';
import { createStripeWebhookVerifier } from '../adapters/billing/stripe-webhook-verifier';
import { cryptoRandom } from '../adapters/crypto-random';
import { createMemoryLogger } from '../adapters/memory-logger';
import { createBillingService, type BillingService } from '../domain/billing/billing-service';
import type { BillingStore } from '../domain/billing/billing-store';
import { createSubscriptionEntitlements, type Entitlements } from '../domain/billing/entitlements';
import type { PlanCatalogue } from '../domain/billing/plan-catalogue';
import type { Clock } from '../domain/ports/clock';
import type { Logger } from '../domain/ports/logger';
import { syntheticWebhookSecret } from './billing-fixtures';
import { createMemoryBillingStore } from './memory-billing-store';

export interface TestBilling {
    readonly billing: BillingService;
    readonly entitlements: Entitlements;
    readonly store: BillingStore;
    readonly provider: FakeBillingState;
    readonly webhookSecret: string;
}

/**
 * Billing as dev wires it, the fake provider with Stripe's real webhook verification, around the given store. The
 * default store accepts any organization, for tests that never look at billing.
 */
export function createTestBilling(deps: {
    readonly clock: Clock;
    readonly catalogue: PlanCatalogue;
    readonly dashboardOrigin: string;
    readonly store?: BillingStore;
    readonly logger?: Logger;
    readonly webhookSecret?: string;
}): TestBilling {
    const store =
        deps.store ?? createMemoryBillingStore({ org: (id) => ({ id, kind: 'personal', name: null, createdAt: 0 }) });
    const provider = createFakeBillingState();
    const webhookSecret = deps.webhookSecret ?? syntheticWebhookSecret();
    const billing: BillingService = createBillingService({
        store,
        provider: createFakeBillingProvider({
            state: provider,
            random: cryptoRandom,
            clock: deps.clock,
            dashboardOrigin: deps.dashboardOrigin,
            verifyWebhook: createStripeWebhookVerifier({ secret: webhookSecret, clock: deps.clock }),
            deliver: (event, signal) => billing.handleEvent(event, signal),
        }),
        catalogue: deps.catalogue,
        clock: deps.clock,
        logger: deps.logger ?? createMemoryLogger(),
    });
    return {
        billing,
        entitlements: createSubscriptionEntitlements({ store, catalogue: deps.catalogue }),
        store,
        provider,
        webhookSecret,
    };
}
