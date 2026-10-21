import type {
    BillingEvent,
    BillingProvider,
    ProviderSubscription,
    WebhookVerification,
} from '../../domain/billing/billing-provider';
import type { OrgId } from '../../domain/ids';
import type { Clock } from '../../domain/ports/clock';
import type { Random } from '../../domain/ports/random';

const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/** What the fake "Stripe" holds; lives as long as the isolate in dev, per test otherwise. */
export interface FakeBillingState {
    readonly customers: Map<string, { readonly orgId: OrgId; readonly email: string }>;
    readonly subscriptions: Map<string, ProviderSubscription>;
    readonly checkouts: { readonly orgId: OrgId; readonly customerId: string; readonly priceId: string }[];
    readonly portals: { readonly customerId: string }[];
}

export function createFakeBillingState(): FakeBillingState {
    return { customers: new Map(), subscriptions: new Map(), checkouts: [], portals: [] };
}

function fakeId(prefix: string, random: Random): string {
    return `${prefix}_fake${Array.from(random.bytes(12), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The in-memory billing provider for dev and the e2e stack (D-01's config refuses it elsewhere). Checkout completes at
 * once: the subscription becomes `active` here and a `checkout.session.completed` event goes through `deliver`, the
 * same handler a verified Stripe webhook reaches. Nothing touches the network.
 */
export function createFakeBillingProvider(deps: {
    readonly state: FakeBillingState;
    readonly random: Random;
    readonly clock: Clock;
    readonly dashboardOrigin: string;
    readonly verifyWebhook: (payload: Uint8Array, signature: string) => Promise<WebhookVerification>;
    readonly deliver: (event: BillingEvent, signal: AbortSignal) => Promise<unknown>;
}): BillingProvider {
    const { state, random, clock, dashboardOrigin } = deps;
    return {
        createCustomer({ orgId, email }) {
            const customerId = fakeId('cus', random);
            state.customers.set(customerId, { orgId, email });
            return Promise.resolve({ customerId });
        },

        async createCheckoutSession({ orgId, customerId, priceId }, signal) {
            state.checkouts.push({ orgId, customerId, priceId });
            const subscription: ProviderSubscription = {
                id: fakeId('sub', random),
                customerId,
                status: 'active',
                priceId,
                quantity: 1,
                currentPeriodEnd: clock.nowMs() + PERIOD_MS,
                cancelAtPeriodEnd: false,
            };
            state.subscriptions.set(subscription.id, subscription);
            await deps.deliver(
                { id: fakeId('evt', random), type: 'checkout.session.completed', subscriptionId: subscription.id },
                signal,
            );
            return { url: `${dashboardOrigin}/billing?checkout=success` };
        },

        createPortalSession({ customerId }) {
            state.portals.push({ customerId });
            return Promise.resolve({ url: `${dashboardOrigin}/billing` });
        },

        getSubscription: (subscriptionId) => Promise.resolve(state.subscriptions.get(subscriptionId) ?? null),

        verifyWebhook: deps.verifyWebhook,
    };
}
