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

// Engine registration (D-03): routing and billing metadata only, never engine content.

export const linkCodes = sqliteTable(
    'link_codes',
    {
        // SHA-256 of the link code; the code itself is shown once and never stored.
        codeHash: text('code_hash').primaryKey(),
        orgId: text('org_id')
            .notNull()
            .references(() => organizations.id),
        createdByUserId: text('created_by_user_id').notNull(),
        createdAt: integer('created_at').notNull(),
        expiresAt: integer('expires_at').notNull(),
        usedAt: integer('used_at'),
        engineId: text('engine_id'),
    },
    (t) => [index('link_codes_org_id_created_at_idx').on(t.orgId, t.createdAt)],
);

export const engines = sqliteTable(
    'engines',
    {
        engineId: text('engine_id').primaryKey(),
        orgId: text('org_id')
            .notNull()
            .references(() => organizations.id),
        publicKey: text('public_key').notNull().unique(),
        hostname: text('hostname').notNull().unique(),
        mode: text('mode', { enum: ['tunnel', 'direct'] }).notNull(),
        engineVersion: text('engine_version').notNull(),
        status: text('status', { enum: ['active', 'suspended'] })
            .notNull()
            .default('active'),
        statusReason: text('status_reason'),
        createdAt: integer('created_at').notNull(),
        updatedAt: integer('updated_at').notNull(),
    },
    (t) => [
        check('engines_status_check', sql`${t.status} in ('active', 'suspended')`),
        check('engines_mode_check', sql`${t.mode} in ('tunnel', 'direct')`),
        index('engines_org_id_idx').on(t.orgId),
    ],
);

// Relay keys (D-04): one row per token, so two live tokens of one relay overlap during rotation (ADR 0014).
export const relayTokens = sqliteTable(
    'relay_tokens',
    {
        id: text('id').primaryKey(),
        relayId: text('relay_id').notNull(),
        // SHA-256 of the token; the token itself is printed once by scripts/mint-relay-key.ts and never stored.
        tokenHash: text('token_hash').notNull().unique(),
        createdAt: integer('created_at').notNull(),
        expiresAt: integer('expires_at').notNull(),
        lastUsedAt: integer('last_used_at'),
        revokedAt: integer('revoked_at'),
    },
    (t) => [index('relay_tokens_relay_id_idx').on(t.relayId)],
);

// Custom hostnames (D-08): which engine serves a customer's hostname, with the engine's signed claim for it. Only
// `active` rows reach relays, and relays verify the claim and the CNAME again on their own.
export const engineHostnames = sqliteTable(
    'engine_hostnames',
    {
        hostname: text('hostname').primaryKey(),
        engineId: text('engine_id')
            .notNull()
            .references(() => engines.engineId),
        orgId: text('org_id').notNull(),
        claimSig: text('claim_sig').notNull(),
        status: text('status', { enum: ['pending-dns', 'active'] }).notNull(),
        dnsCheckedAt: integer('dns_checked_at'),
        createdAt: integer('created_at').notNull(),
        createdByUserId: text('created_by_user_id').notNull(),
    },
    (t) => [
        check('engine_hostnames_status_check', sql`${t.status} in ('pending-dns', 'active')`),
        // Every registry read looks an engine's rows up.
        index('engine_hostnames_engine_id_idx').on(t.engineId),
    ],
);

// Organization audit (D-06): who did what to which of the organization's resources. Insert only: the repository
// exposes no update or delete, like `admin_audit_log`.
export const orgAuditLog = sqliteTable(
    'org_audit_log',
    {
        id: text('id').primaryKey(),
        orgId: text('org_id')
            .notNull()
            .references(() => organizations.id),
        actorUserId: text('actor_user_id').notNull(),
        action: text('action').notNull(),
        targetType: text('target_type').notNull(),
        targetId: text('target_id').notNull(),
        createdAt: integer('created_at').notNull(),
    },
    (t) => [index('org_audit_log_org_id_created_at_idx').on(t.orgId, t.createdAt)],
);

// Abuse monitoring (I-05): public metadata about certificates for the engine domain, and what the public-face check
// saw. Certificate metadata and fingerprints only, never a page body.

/**
 * Every certificate for the engine domain seen in Certificate Transparency, once. The key is SHA-256 over its issuer,
 * validity start and names: crt.sh's JSON carries no certificate hash, and a precertificate and its certificate, or the
 * same issuance from both sources, must count once. Pruned 400 days after it was first seen, past any validity.
 */
export const ctCerts = sqliteTable(
    'ct_certs',
    {
        issuanceSha256: text('issuance_sha256').primaryKey(),
        source: text('source', { enum: ['crt.sh', 'certspotter'] }).notNull(),
        firstSeenAt: integer('first_seen_at').notNull(),
        /** Start of the certificate's validity: when it was issued, for the issuance-count rule. */
        notBefore: integer('not_before').notNull(),
        /** JSON array of the certificate's DNS names, lower-case. */
        hostnames: text('hostnames').notNull(),
        issuer: text('issuer').notNull(),
        /** Comma-separated reasons it was flagged (`wildcard`, `foreign-issuer`, `unknown-hostname`), or null. */
        alert: text('alert'),
    },
    (t) => [
        check('ct_certs_source_check', sql`${t.source} in ('crt.sh', 'certspotter')`),
        index('ct_certs_first_seen_at_idx').on(t.firstSeenAt),
        index('ct_certs_not_before_idx').on(t.notBefore),
    ],
);

/** Where each CT source's next query starts. */
export const ctCursors = sqliteTable('ct_cursors', {
    source: text('source').primaryKey(),
    cursor: text('cursor').notNull(),
});

/** One anonymous visit to an engine's default hostname; kept 30 days. */
export const publicFaceChecks = sqliteTable(
    'public_face_checks',
    {
        engineId: text('engine_id')
            .notNull()
            .references(() => engines.engineId),
        checkedAt: integer('checked_at').notNull(),
        result: text('result', { enum: ['match', 'mismatch', 'unreachable'] }).notNull(),
        /** SHA-256 of what the visit saw (status, path, media type, title); null when unreachable. */
        fingerprint: text('fingerprint'),
    },
    (t) => [
        primaryKey({ columns: [t.engineId, t.checkedAt] }),
        check('public_face_checks_result_check', sql`${t.result} in ('match', 'mismatch', 'unreachable')`),
        index('public_face_checks_checked_at_idx').on(t.checkedAt),
    ],
);

// Relay presence (R-07): when each relay last reported, and the engines it then held a ready tunnel for. Every report
// replaces the relay's rows; a relay silent past the expiry is deleted with its rows. No history, no addresses.
export const relayPresenceReports = sqliteTable('relay_presence_reports', {
    relayId: text('relay_id').primaryKey(),
    reportedAt: integer('reported_at').notNull(),
});

// No reference to `engines`: a relay only holds tunnels for engines the registry served it, and a row for an engine
// removed since is replaced by the relay's next report.
export const relayPresence = sqliteTable(
    'relay_presence',
    {
        relayId: text('relay_id')
            .notNull()
            .references(() => relayPresenceReports.relayId, { onDelete: 'cascade' }),
        engineId: text('engine_id').notNull(),
    },
    (t) => [
        primaryKey({ columns: [t.relayId, t.engineId] }),
        // The engine list counts relays per engine.
        index('relay_presence_engine_id_idx').on(t.engineId),
    ],
);
