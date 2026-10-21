import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

/**
 * Every table and column the dashboard stores, after all migrations. A new column fails this test until it is added
 * here, so each one is a deliberate review point for "the dashboard stores no engine content" (AGENTS.md rule 2):
 * no prompts, messages, files or agent output, not even encrypted.
 */
const ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
    // The organization's Stripe customer ID; the email and payment details live at Stripe only.
    billing_customers: ['org_id', 'stripe_customer_id', 'created_at'],
    // Insert-only record of platform admin actions: who, what, on which target, why. No engine content.
    admin_audit_log: ['id', 'admin_user_id', 'action', 'target_type', 'target_id', 'reason', 'created_at'],
    // Signup and recovery links: the token only as SHA-256, the address it was sent to, 15-minute lifetime.
    email_tokens: ['token_hash', 'purpose', 'email', 'user_id', 'created_at', 'expires_at', 'used_at'],
    // Registered engines: the public key and what derives from it, the mode and version the engine signed, and the
    // dashboard's status for it. Routing and billing metadata only.
    engines: [
        'engine_id',
        'org_id',
        'public_key',
        'hostname',
        'mode',
        'engine_version',
        'status',
        'status_reason',
        'created_at',
        'updated_at',
    ],
    // One-time link codes: the code only as SHA-256, who issued it for which organization, a 30-minute lifetime, and
    // the engine that redeemed it.
    link_codes: ['code_hash', 'org_id', 'created_by_user_id', 'created_at', 'expires_at', 'used_at', 'engine_id'],
    memberships: ['org_id', 'user_id', 'role', 'created_at'],
    // Relay keys: the token only as SHA-256, which relay it belongs to, its lifetime and last use (D-04).
    relay_tokens: ['id', 'relay_id', 'token_hash', 'created_at', 'expires_at', 'last_used_at', 'revoked_at'],
    organizations: ['id', 'kind', 'name', 'created_at'],
    // Dashboard passkeys: public keys and counters only; private keys never leave the authenticator.
    passkeys: [
        'credential_id',
        'user_id',
        'public_key',
        'counter',
        'transports',
        'backed_up',
        'added_via',
        'created_at',
        'last_used_at',
        'counter_regressed_at',
    ],
    // Webhook idempotency: Stripe event IDs and types, never payloads; pruned after 30 days.
    stripe_events: ['event_id', 'type', 'received_at'],
    // The organization's subscription state as fetched from Stripe; no card, address or invoice data.
    subscriptions: [
        'org_id',
        'stripe_subscription_id',
        'status',
        'price_id',
        'quantity',
        'current_period_end',
        'cancel_at_period_end',
        'updated_at',
    ],
    // Session IDs only as SHA-256.
    sessions: [
        'id_hash',
        'user_id',
        'active_org_id',
        'created_at',
        'last_seen_at',
        'expires_at',
        'stepped_up_at',
        'revoked_at',
    ],
    users: [
        'id',
        'email',
        'email_verified_at',
        'locale',
        'platform_role',
        'recovered_at',
        'created_at',
        'webauthn_user_id',
    ],
    // Live WebAuthn ceremonies, at most 5 minutes each.
    webauthn_challenges: ['id', 'challenge', 'purpose', 'user_id', 'token_hash', 'webauthn_user_id', 'expires_at'],
};

async function storedColumns(): Promise<Record<string, string[]>> {
    const tables = await env.DB.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name",
    ).all<{ name: string }>();
    const out: Record<string, string[]> = {};
    for (const { name } of tables.results) {
        const columns = await env.DB.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').bind(name).all<{
            name: string;
        }>();
        out[name] = columns.results.map((column) => column.name);
    }
    return out;
}

describe('D1 schema', () => {
    it('matches the content allowlist exactly', async () => {
        expect(await storedColumns()).toEqual(ALLOWLIST);
    });
});
