import { desc, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';

import { OPEN_STATUSES, isOpenSubscription } from '../../domain/billing/billing-state';
import type { BillingStore, SubscriptionRecord } from '../../domain/billing/billing-store';
import { orgIdSchema } from '../../domain/ids';
import { billingStatusSchema, PROBLEM_STATUSES, problemStatusSchema } from '../../shared/billing';
import type { Database } from './client';
import { billingCustomers, organizations, stripeEvents, subscriptions } from './schema';

function toSubscription(row: typeof subscriptions.$inferSelect): SubscriptionRecord {
    return {
        orgId: orgIdSchema.parse(row.orgId),
        subscriptionId: row.stripeSubscriptionId,
        status: billingStatusSchema.parse(row.status),
        priceId: row.priceId,
        quantity: row.quantity,
        currentPeriodEnd: row.currentPeriodEnd,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        updatedAt: row.updatedAt,
    };
}

/** `shouldReplace` from the domain, as the `WHERE` of the upsert, so concurrent webhooks cannot race past it. */
function replacementCondition(incoming: SubscriptionRecord) {
    const same = sql`${subscriptions.stripeSubscriptionId} = ${incoming.subscriptionId}`;
    const sameAndNotNewer = sql`(${same} and ${subscriptions.updatedAt} <= ${incoming.updatedAt})`;
    return isOpenSubscription(incoming.status)
        ? sql`${sameAndNotNewer} or not ${same}`
        : sql`${sameAndNotNewer} or (not ${same} and ${notInArray(subscriptions.status, [...OPEN_STATUSES])})`;
}

/** D1 through Drizzle's core query builder; every organization-owned query filters by `org_id`. */
export function createD1BillingStore(db: Database): BillingStore {
    return {
        async findCustomer(orgId) {
            const row = await db
                .select({ customerId: billingCustomers.stripeCustomerId })
                .from(billingCustomers)
                .where(eq(billingCustomers.orgId, orgId))
                .get();
            return row?.customerId ?? null;
        },

        async saveCustomer(orgId, customerId, now) {
            await db
                .insert(billingCustomers)
                .values({ orgId, stripeCustomerId: customerId, createdAt: now })
                .onConflictDoNothing({ target: billingCustomers.orgId });
            const stored = await this.findCustomer(orgId);
            if (stored === null) {
                throw new Error('billing customer missing right after it was saved');
            }
            return stored;
        },

        async findOrgByCustomer(customerId) {
            const row = await db
                .select({ orgId: billingCustomers.orgId })
                .from(billingCustomers)
                .where(eq(billingCustomers.stripeCustomerId, customerId))
                .get();
            return row === undefined ? null : orgIdSchema.parse(row.orgId);
        },

        async findSubscription(orgId) {
            const row = await db.select().from(subscriptions).where(eq(subscriptions.orgId, orgId)).get();
            return row === undefined ? null : toSubscription(row);
        },

        async hasEvent(eventId) {
            const row = await db
                .select({ eventId: stripeEvents.eventId })
                .from(stripeEvents)
                .where(eq(stripeEvents.eventId, eventId))
                .get();
            return row !== undefined;
        },

        async recordEvent(event, subscription) {
            const insertEvent = db.insert(stripeEvents).values(event).onConflictDoNothing();
            if (subscription === null) {
                await insertEvent;
                return;
            }
            const values = {
                stripeSubscriptionId: subscription.subscriptionId,
                status: subscription.status,
                priceId: subscription.priceId,
                quantity: subscription.quantity,
                currentPeriodEnd: subscription.currentPeriodEnd,
                cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
                updatedAt: subscription.updatedAt,
            };
            await db.batch([
                insertEvent,
                db
                    .insert(subscriptions)
                    .values({ orgId: subscription.orgId, ...values })
                    .onConflictDoUpdate({
                        target: subscriptions.orgId,
                        set: values,
                        setWhere: replacementCondition(subscription),
                    }),
            ]);
        },

        async pruneEvents(before) {
            await db.delete(stripeEvents).where(lt(stripeEvents.receivedAt, before));
        },

        async listProblemOrganizations() {
            const rows = await db
                .select({ subscription: subscriptions, org: organizations })
                .from(subscriptions)
                .innerJoin(organizations, eq(organizations.id, subscriptions.orgId))
                .where(inArray(subscriptions.status, [...PROBLEM_STATUSES]))
                .orderBy(desc(subscriptions.updatedAt), subscriptions.orgId)
                .all();
            return rows.map(({ subscription, org }) => ({
                orgId: orgIdSchema.parse(org.id),
                kind: org.kind,
                name: org.name,
                status: problemStatusSchema.parse(subscription.status),
                currentPeriodEnd: subscription.currentPeriodEnd,
                updatedAt: subscription.updatedAt,
            }));
        },
    };
}
