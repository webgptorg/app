import { sql } from 'drizzle-orm';
import { blob, check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Timestamps are integers in milliseconds since the Unix epoch. Every column is an explicit review point for
// "the dashboard stores no engine content" (schema-allowlist.test.ts).

export const organizations = sqliteTable(
    'organizations',
    {
        id: text('id').primaryKey(),
        kind: text('kind', { enum: ['personal', 'team'] }).notNull(),
        name: text('name'),
        createdAt: integer('created_at').notNull(),
    },
    (t) => [check('organizations_kind_check', sql`${t.kind} in ('personal', 'team')`)],
);

export const users = sqliteTable('users', {
    id: text('id').primaryKey(),
    email: text('email').notNull().unique(),
    emailVerifiedAt: integer('email_verified_at'),
    locale: text('locale').notNull().default('en'),
    platformRole: text('platform_role').notNull().default('none'),
    recoveredAt: integer('recovered_at'),
    createdAt: integer('created_at').notNull(),
    // The WebAuthn user handle: random, never the email, so authenticators never learn who the account belongs to.
    webauthnUserId: blob('webauthn_user_id', { mode: 'buffer' }).unique(),
});

export const memberships = sqliteTable(
    'memberships',
    {
        orgId: text('org_id')
            .notNull()
            .references(() => organizations.id),
        userId: text('user_id')
            .notNull()
            .references(() => users.id),
        role: text('role').notNull(),
        createdAt: integer('created_at').notNull(),
    },
    (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

export const passkeys = sqliteTable(
    'passkeys',
    {
        credentialId: text('credential_id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id),
        publicKey: blob('public_key', { mode: 'buffer' }).notNull(),
        counter: integer('counter').notNull(),
        transports: text('transports'),
        backedUp: integer('backed_up', { mode: 'boolean' }).notNull(),
        addedVia: text('added_via', { enum: ['signup', 'account', 'recovery'] }).notNull(),
        createdAt: integer('created_at').notNull(),
        lastUsedAt: integer('last_used_at'),
        // A signature counter that went backwards from a non-zero value: a possibly cloned authenticator (ADR 0014).
        counterRegressedAt: integer('counter_regressed_at'),
    },
    (t) => [
        check('passkeys_added_via_check', sql`${t.addedVia} in ('signup', 'account', 'recovery')`),
        index('passkeys_user_id_idx').on(t.userId),
    ],
);

export const sessions = sqliteTable(
    'sessions',
    {
        // SHA-256 of the cookie value; the value itself is never stored.
        idHash: text('id_hash').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id),
        activeOrgId: text('active_org_id')
            .notNull()
            .references(() => organizations.id),
        createdAt: integer('created_at').notNull(),
        lastSeenAt: integer('last_seen_at').notNull(),
        expiresAt: integer('expires_at').notNull(),
        steppedUpAt: integer('stepped_up_at'),
        revokedAt: integer('revoked_at'),
    },
    (t) => [index('sessions_user_id_idx').on(t.userId)],
);

export const emailTokens = sqliteTable(
    'email_tokens',
    {
        // SHA-256 of the emailed token; the token itself is never stored.
        tokenHash: text('token_hash').primaryKey(),
        purpose: text('purpose', { enum: ['signup', 'recovery'] }).notNull(),
        email: text('email').notNull(),
        userId: text('user_id'),
        createdAt: integer('created_at').notNull(),
        expiresAt: integer('expires_at').notNull(),
        usedAt: integer('used_at'),
    },
    (t) => [
        check('email_tokens_purpose_check', sql`${t.purpose} in ('signup', 'recovery')`),
        index('email_tokens_email_purpose_idx').on(t.email, t.purpose),
    ],
);

export const webauthnChallenges = sqliteTable(
    'webauthn_challenges',
    {
        id: text('id').primaryKey(),
        challenge: text('challenge').notNull(),
        purpose: text('purpose').notNull(),
        userId: text('user_id'),
        tokenHash: text('token_hash'),
        // Signup only: the user handle offered in the options, kept until verify creates the user with it.
        webauthnUserId: blob('webauthn_user_id', { mode: 'buffer' }),
        expiresAt: integer('expires_at').notNull(),
    },
    (t) => [index('webauthn_challenges_expires_at_idx').on(t.expiresAt)],
);

// Insert only: the repository exposes no update or delete.
export const adminAuditLog = sqliteTable('admin_audit_log', {
    id: text('id').primaryKey(),
    adminUserId: text('admin_user_id').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    reason: text('reason'),
    createdAt: integer('created_at').notNull(),
});

// Billing (D-07): account and organization metadata only. Stripe holds cards, addresses and invoices.

// The organization owns the Stripe customer (ADR 0006), so team billing later needs no migration.
export const billingCustomers = sqliteTable('billing_customers', {
    orgId: text('org_id')
        .primaryKey()
        .references(() => organizations.id),
    stripeCustomerId: text('stripe_customer_id').notNull().unique(),
    createdAt: integer('created_at').notNull(),
});

export const subscriptions = sqliteTable(
    'subscriptions',
    {
        orgId: text('org_id')
            .primaryKey()
            .references(() => organizations.id),
        stripeSubscriptionId: text('stripe_subscription_id').notNull().unique(),
        // Our BillingStatus, mapped from Stripe's; no CHECK, so a new status needs no table rebuild.
        status: text('status').notNull(),
        priceId: text('price_id').notNull(),
        quantity: integer('quantity'),
        currentPeriodEnd: integer('current_period_end'),
        cancelAtPeriodEnd: integer('cancel_at_period_end', { mode: 'boolean' }).notNull(),
        updatedAt: integer('updated_at').notNull(),
    },
    (t) => [index('subscriptions_status_idx').on(t.status)],
);

// Webhook idempotency: event IDs and types only, never payloads; pruned after 30 days.
export const stripeEvents = sqliteTable(
    'stripe_events',
    {
        eventId: text('event_id').primaryKey(),
        type: text('type').notNull(),
        receivedAt: integer('received_at').notNull(),
    },
    (t) => [index('stripe_events_received_at_idx').on(t.receivedAt)],
);
