import { sql } from 'drizzle-orm';
import { check, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
