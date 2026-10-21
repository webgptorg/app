import { QUOTAS, type BillingStatus, type Feature, type Quota } from '../../shared/billing';
import type { OrgId } from '../ids';
import type { Clock } from '../ports/clock';
import type { Logger } from '../ports/logger';
import { billingState, isOpenSubscription } from './billing-state';
import type { BillingEvent, BillingProvider, WebhookVerification } from './billing-provider';
import type { BillingStore, ProblemOrganizationRecord, SubscriptionRecord } from './billing-store';
import { resolvePlan } from './entitlements';
import type { Plan, PlanCatalogue } from './plan-catalogue';

/** Stripe retries a failed delivery for up to three days; a month of event IDs covers every retry with margin. */
export const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The events that can change an organization's subscription; every other type is acknowledged and ignored. */
const HANDLED_EVENTS: ReadonlySet<string> = new Set([
    'checkout.session.completed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.paid',
    'invoice.payment_failed',
]);

export interface QuotaUsage {
    readonly quota: Quota;
    readonly limit: number | null;
    /** Null until the module that owns the counted resource reports usage (engines D-03, custom domains D-08). */
    readonly used: number | null;
}

export interface BillingOverview {
    readonly status: BillingStatus;
    readonly currentPeriodEnd: number | null;
    readonly cancelAtPeriodEnd: boolean;
    readonly plan: Plan;
    readonly hasBillingAccount: boolean;
    readonly canSubscribe: boolean;
    readonly features: readonly Feature[];
    readonly quotas: readonly QuotaUsage[];
    readonly plans: readonly Plan[];
}

export type CheckoutOutcome =
    | { readonly kind: 'ok'; readonly url: string }
    | { readonly kind: 'unknown-plan' }
    | { readonly kind: 'already-subscribed' };

export type EventOutcome = 'processed' | 'duplicate' | 'ignored';

export interface BillingService {
    overview(orgId: OrgId): Promise<BillingOverview>;
    checkout(
        input: { readonly orgId: OrgId; readonly email: string; readonly planId: string },
        signal: AbortSignal,
    ): Promise<CheckoutOutcome>;
    portal(
        input: { readonly orgId: OrgId; readonly email: string },
        signal: AbortSignal,
    ): Promise<{ readonly url: string }>;
    verifyWebhook(payload: Uint8Array, signature: string): Promise<WebhookVerification>;
    /** Idempotent: a repeated event ID is skipped, and the state applied is always the provider's current one. */
    handleEvent(event: BillingEvent, signal: AbortSignal): Promise<EventOutcome>;
    problemOrganizations(): Promise<readonly ProblemOrganizationRecord[]>;
}

export interface BillingDeps {
    readonly store: BillingStore;
    readonly provider: BillingProvider;
    readonly catalogue: PlanCatalogue;
    readonly clock: Clock;
    readonly logger: Logger;
}

export function createBillingService(deps: BillingDeps): BillingService {
    const { store, provider, catalogue, clock, logger } = deps;

    async function ensureCustomer(orgId: OrgId, email: string, signal: AbortSignal): Promise<string> {
        const existing = await store.findCustomer(orgId);
        if (existing !== null) {
            return existing;
        }
        const { customerId } = await provider.createCustomer({ orgId, email }, signal);
        return store.saveCustomer(orgId, customerId, clock.nowMs());
    }

    async function currentRecord(event: BillingEvent, signal: AbortSignal): Promise<SubscriptionRecord | null> {
        if (event.subscriptionId === null) {
            return null;
        }
        const fetchedAt = clock.nowMs();
        const subscription = await provider.getSubscription(event.subscriptionId, signal);
        if (subscription === null) {
            logger.warn('billing.webhook.unknown-subscription', { eventId: event.id, type: event.type });
            return null;
        }
        const orgId = await store.findOrgByCustomer(subscription.customerId);
        if (orgId === null) {
            logger.warn('billing.webhook.unknown-customer', { eventId: event.id, type: event.type });
            return null;
        }
        return {
            orgId,
            subscriptionId: subscription.id,
            status: subscription.status,
            priceId: subscription.priceId,
            quantity: subscription.quantity,
            currentPeriodEnd: subscription.currentPeriodEnd,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            updatedAt: fetchedAt,
        };
    }

    return {
        async overview(orgId) {
            const [customerId, subscription] = await Promise.all([
                store.findCustomer(orgId),
                store.findSubscription(orgId),
            ]);
            const state = billingState(subscription);
            const plan = resolvePlan(catalogue, subscription);
            const status = subscription?.status ?? 'none';
            return {
                status,
                currentPeriodEnd: state.kind === 'none' ? null : state.currentPeriodEnd,
                cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
                plan,
                hasBillingAccount: customerId !== null,
                canSubscribe: !isOpenSubscription(status),
                features: plan.features,
                quotas: QUOTAS.map((quota) => ({ quota, limit: plan.quotas[quota], used: null })),
                plans: catalogue.plans,
            };
        },

        async checkout({ orgId, email, planId }, signal) {
            const plan = catalogue.byId(planId);
            if (plan === null) {
                return { kind: 'unknown-plan' };
            }
            const subscription = await store.findSubscription(orgId);
            if (subscription !== null && isOpenSubscription(subscription.status)) {
                return { kind: 'already-subscribed' };
            }
            const customerId = await ensureCustomer(orgId, email, signal);
            const { url } = await provider.createCheckoutSession(
                { orgId, customerId, priceId: plan.stripePriceId },
                signal,
            );
            return { kind: 'ok', url };
        },

        async portal({ orgId, email }, signal) {
            const customerId = await ensureCustomer(orgId, email, signal);
            return provider.createPortalSession({ customerId }, signal);
        },

        verifyWebhook: (payload, signature) => provider.verifyWebhook(payload, signature),

        async handleEvent(event, signal) {
            if (!HANDLED_EVENTS.has(event.type)) {
                logger.info('billing.webhook.ignored', { eventId: event.id, type: event.type });
                return 'ignored';
            }
            if (await store.hasEvent(event.id)) {
                logger.info('billing.webhook.duplicate', { eventId: event.id, type: event.type });
                return 'duplicate';
            }
            const subscription = await currentRecord(event, signal);
            const receivedAt = clock.nowMs();
            // Recorded only once handled: a failure above answers 500 and Stripe's retry runs it again.
            await store.recordEvent({ eventId: event.id, type: event.type, receivedAt }, subscription);
            await store.pruneEvents(receivedAt - EVENT_RETENTION_MS);
            logger.info('billing.webhook.processed', { eventId: event.id, type: event.type });
            return 'processed';
        },

        problemOrganizations: () => store.listProblemOrganizations(),
    };
}
