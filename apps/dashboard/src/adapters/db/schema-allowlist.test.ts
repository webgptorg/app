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
    // Insert-only record of what organization members did to the organization's resources (D-06: engine revocation):
    // who, what, on which target. No engine content, no free text.
    org_audit_log: ['id', 'org_id', 'actor_user_id', 'action', 'target_type', 'target_id', 'created_at'],
    // Signup and recovery links: the token only as SHA-256, the address it was sent to, 15-minute lifetime.
    email_tokens: ['token_hash', 'purpose', 'email', 'user_id', 'created_at', 'expires_at', 'used_at'],
    // Certificates for the engine domain from Certificate Transparency (I-05): public metadata only, the names, the
    // issuer, when it was issued, which source first showed it and why it was flagged.
    ct_certs: ['issuance_sha256', 'source', 'first_seen_at', 'not_before', 'hostnames', 'issuer', 'alert'],
    // Where each CT source's next query starts.
    ct_cursors: ['source', 'cursor'],
    // Registered engines: the public key and what derives from it, the mode and version the engine signed, and the
    // dashboard's status for it. Routing and billing metadata only, plus the owner's own label for it: account metadata
    // typed in the dashboard, never sent to or read from the engine.
    // Custom hostnames (D-08): the customer's hostname, which engine and organization it belongs to, the engine's
    // signature claiming it, whether its CNAME was seen, and which platform admin added it. Routing metadata only.
    engine_hostnames: [
        'hostname',
        'engine_id',
        'org_id',
        'claim_sig',
        'status',
        'dns_checked_at',
        'created_at',
        'created_by_user_id',
    ],
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
        'label',
        'team_id',
    ],
    // One-time link codes: the code only as SHA-256, who issued it for which organization, a 30-minute lifetime, the
    // engine that redeemed it and the team that engine joins.
    vps_oauth_clients: ['callback', 'client_id'],
    link_codes: [
        'code_hash',
        'org_id',
        'created_by_user_id',
        'created_at',
        'expires_at',
        'used_at',
        'engine_id',
        'id',
        'team_id',
        'vps_provider',
        'vps_resource_id',
    ],
    // Teams (ADR 0018): a name the organization typed, and who is in it. No engine content.
    teams: ['id', 'org_id', 'name', 'created_at', 'deleted_at'],
    team_members: ['team_id', 'user_id', 'created_at', 'access'],
    // Access tickets the dashboard signed: which person it sent to which engine, and the engine's ack. Never the ticket.
    access_tickets: [
        'id',
        'team_id',
        'engine_id',
        'user_id',
        'issued_at',
        'expires_at',
        'outcome',
        'outcome_at',
        'noticed_at',
    ],
    // Invitations: the token only as SHA-256, the invited address, role and teams, 7-day lifetime.
    invites: [
        'id',
        'token_hash',
        'org_id',
        'email',
        'role',
        'team_ids',
        'invited_by_user_id',
        'created_at',
        'expires_at',
        'accepted_at',
        'revoked_at',
    ],
    // Removals owed to an engine: which engine, which dashboard user, and the engine's ack. No engine content.
    member_revocations: ['id', 'engine_id', 'user_id', 'created_at', 'acked_at', 'outcome'],
    memberships: ['org_id', 'user_id', 'role', 'created_at'],
    // Relay presence (R-07): which engine IDs each relay last reported a ready tunnel for, and when it reported. No
    // addresses, no connect times, no history: each report replaces the relay's rows.
    relay_presence: ['relay_id', 'engine_id'],
    relay_presence_reports: ['relay_id', 'reported_at'],
    // Relay keys: the token only as SHA-256, which relay it belongs to, its lifetime and last use (D-04).
    relay_tokens: ['id', 'relay_id', 'token_hash', 'created_at', 'expires_at', 'last_used_at', 'revoked_at'],
    organizations: ['id', 'kind', 'name', 'created_at', 'trial_started_at'],
    // Dashboard passkeys: public keys and counters only; private keys never leave the authenticator. The AAGUID is the
    // authenticator model (e.g. "Google Password Manager"), shared by every passkey of that model, not a device ID.
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
        'aaguid',
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
    // The public-face check (I-05): what an anonymous visit to an engine's default hostname saw, as a match against
    // the known sign-in page and a SHA-256 fingerprint; never the page itself. Kept 30 days.
    public_face_checks: ['engine_id', 'checked_at', 'result', 'fingerprint'],
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
    // Usage data (ADR 0022, migration 0014_usage_data): funnel events and daily activity for improving the product.
    // Only IDs the dashboard already holds, the event's name and props of numbers, booleans and closed enums validated
    // per event; no names, emails, IP addresses, user agents, tokens or free text. Events kept 13 months.
    usage_events: ['id', 'occurred_at', 'event', 'org_id', 'user_id', 'engine_id', 'props'],
    // An engine's day: how many heartbeats arrived, first and last, and the last one's numbers and closed enums, all of
    // which the heartbeat already carries (C-03). Kept 25 months.
    usage_daily_engines: [
        'day',
        'engine_id',
        'org_id',
        'beats',
        'first_beat_at',
        'last_beat_at',
        'engine_version',
        'agents',
        'members',
        'setup',
        'update_state',
        'cpu_load',
    ],
    // Who used the dashboard on which day, in which organization, from `sessions.last_seen_at`. Kept 25 months.
    usage_daily_people: ['day', 'org_id', 'user_id'],
    // Live WebAuthn ceremonies, at most 5 minutes each.
    webauthn_challenges: ['id', 'challenge', 'purpose', 'user_id', 'token_hash', 'webauthn_user_id', 'expires_at'],
    // Website licensing (D-30): which website account (its subject UUID) licenses the organization, who linked it, when.
    website_links: ['org_id', 'subject', 'linked_by_user_id', 'linked_at'],
    // The website's last licence snapshot: grant IDs, validity dates and numeric capacities, no prices and no content.
    website_license_snapshots: ['org_id', 'subject', 'snapshot', 'fetched_at'],
    // A handoff to the website in flight: its challenge only as SHA-256, a 10-minute lifetime.
    website_handoff_states: ['challenge_hash', 'created_at', 'expires_at'],
    // The website's verified address and subject, waiting 30 minutes for this browser's sign-in or sign-up.
    website_pending_links: ['token_hash', 'subject', 'email', 'created_at', 'expires_at'],
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
