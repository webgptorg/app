import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'vitest';

import {
    DEFAULT_INSTALL_GUIDE_URL,
    fillPlaceholders,
    parseStagingEnv,
    STAGING_FILES,
    StagingValuesError,
    type StagingValues,
} from './placeholders.ts';

const root = resolve(import.meta.dirname, '..', '..');
type Files = Record<keyof typeof STAGING_FILES, string>;
const committed = Object.fromEntries(
    Object.entries(STAGING_FILES).map(([key, path]) => [key, readFileSync(join(root, path), 'utf8')]),
) as Files;

const ALL: StagingValues = {
    SECURITY_CONTACT: 'security@ops.example',
    OPS_EMAIL: 'ops@ops.example',
    ABUSE_EMAIL: 'abuse@ops.example',
    RELAY_IPV4: '198.51.100.10',
    RELAY_IPV6: '2001:db8:1::1',
    D1_DATABASE_ID: '01234567-89ab-cdef-0123-456789abcdef',
};

function productionOf(wrangler: string): string {
    return wrangler.slice(wrangler.indexOf('"production": {'));
}

function stagingOf(wrangler: string): string {
    return wrangler.slice(wrangler.indexOf('"staging": {'), wrangler.indexOf('"production": {'));
}

describe('fillPlaceholders on the committed files', () => {
    const result = fillPlaceholders(committed, ALL);

    // The Stripe IDs wait in the commented-out BILLING_PLANS while billing is off, so they are not left in the config.
    it('leaves no placeholder in the config', () => {
        assert.deepEqual(result.left, []);
    });

    it('fills wrangler.jsonc env.staging consistently with the tfvars', () => {
        const staging = stagingOf(result.files.wrangler);
        assert.match(staging, /"routes": \[\{ "pattern": "app\.ptbk\.io\/\*", "zone_name": "ptbk\.link" \}\]/);
        assert.doesNotMatch(staging, /custom_domain/);
        // The link URL, https://app.ptbk.io/link#<code>, names the dashboard, so the tabs export nothing.
        const tabs = staging.slice(staging.indexOf('"INSTALL_COMMANDS"'), staging.indexOf('"INSTALL_GUIDE_URL"'));
        assert.match(tabs, /--link '\{linkUrl\}'/);
        assert.doesNotMatch(tabs, /export |PTBK_DASHBOARD_URL|PTBK_ENGINE_DOMAIN|\{linkCode\}/);
        assert.match(staging, /"DASHBOARD_ORIGIN": "https:\/\/app\.ptbk\.io"/);
        assert.match(staging, /"relayId": "relay-fsn\.ptbk\.link"/);
        assert.match(staging, /"ENGINE_DOMAIN": "engines\.ptbk\.link"/);
        assert.match(staging, /"database_id": "01234567-89ab-cdef-0123-456789abcdef"/);
        assert.match(staging, /"EMAIL_FROM": "no-reply@mail\.ptbk\.link"/);
        assert.match(staging, /"accountId": "42b20127fa7293cb5160f22ed42ef43b"/);
        assert.ok(staging.includes(`"INSTALL_GUIDE_URL": "${DEFAULT_INSTALL_GUIDE_URL}"`));
        assert.match(result.files.relayTfvars, /registry_url\s+= "https:\/\/app\.ptbk\.io"/);
        assert.match(result.files.cloudflareTfvars, /email_sending_domain = "mail\.ptbk\.link"/);
        assert.match(
            result.files.cloudflareTfvars,
            /dashboard_custom_hostname = \{ hostname = "app\.ptbk\.io", fallback_origin = "app-origin\.ptbk\.link" \}/,
        );
    });

    it('never touches production or the rest of wrangler.jsonc', () => {
        assert.equal(productionOf(result.files.wrangler), productionOf(committed.wrangler));
        const head = committed.wrangler.slice(0, committed.wrangler.indexOf('"staging": {'));
        assert.ok(result.files.wrangler.startsWith(head));
    });

    // lego writes the relay's challenge TXT record straight into the staging zone, so there is nothing to delegate.
    it('adds no ACME challenge CNAME', () => {
        assert.doesNotMatch(result.files.cloudflareTfvars, /extra_records|_acme-challenge/);
    });

    // Admins SSH in from changing networks, so staging opens SSH to every address, keys only (decided 2026-11-06).
    it('keeps the committed admin and SSH open to every address in the relay tfvars', () => {
        assert.match(result.files.relayTfvars, /"seb" = \["ssh-ed25519 [A-Za-z0-9+/]+ seb@sebm\.local"\]/);
        assert.match(result.files.relayTfvars, /ssh_from_anywhere = true\nssh_allowlist\s+= \[\]/);
    });

    it('is idempotent', () => {
        const again = fillPlaceholders(result.files, ALL);
        assert.deepEqual(again.files, result.files);
        assert.deepEqual(again.filled, []);
    });
});

describe('fillPlaceholders in rounds', () => {
    it('fills what is known and names the staging.env key for the rest', () => {
        const first: StagingValues = { ...ALL };
        delete first.RELAY_IPV4;
        delete first.RELAY_IPV6;
        delete first.D1_DATABASE_ID;
        const round = fillPlaceholders(committed, first);
        const left = round.left.filter(({ reason }) => reason.startsWith('needs'));
        assert.deepEqual(left.map(({ placeholder }) => placeholder).sort(), [
            '<staging-d1-id>',
            '<staging-relay-fsn-ipv4>',
            '<staging-relay-fsn-ipv6>',
        ]);
        assert.ok(left.find(({ placeholder }) => placeholder === '<staging-d1-id>')?.reason.includes('D1_DATABASE_ID'));
        assert.deepEqual(fillPlaceholders(round.files, ALL).files, fillPlaceholders(committed, ALL).files);
    });
});

describe('parseStagingEnv', () => {
    it('reads KEY=value lines, skipping comments, blanks and empty values', () => {
        const values = parseStagingEnv(
            '# staging\n\nRELAY_IPV4=198.51.100.10\nRELAY_IPV6=\nOPS_EMAIL="ops@ops.example"\n',
        );
        assert.deepEqual(values, { RELAY_IPV4: '198.51.100.10', OPS_EMAIL: 'ops@ops.example' });
    });

    for (const [text, why] of [
        ['OPS_EMAIL', 'not KEY=value'],
        ['STRIPE_SECRET_KEY=sk_test_x', 'an unknown key (no secrets belong here)'],
        ['SECURITY_CONTACT=<security-contact>', 'a placeholder'],
        ['CLOUDFLARE_ACCOUNT_ID=42b20127fa7293cb5160f22ed42ef43b', 'the account ID, which is committed'],
        ['OPS_EMAIL=ops@Example.COM', 'an upper-case address'],
        ['OPS_EMAIL=ops@ops.example"x', 'a quote, which would break out of the HCL string'],
        ['ADMIN_CIDRS=203.0.113.7/32', 'an SSH allowlist (staging SSH is open, keys only)'],
        ['ADMIN_SSH_PUBLIC_KEY=ssh-ed25519 AAAA seb', 'an admin key (committed in the relay tfvars)'],
        ['RELAY_IPV6=2001:DB8::1', 'an upper-case IPv6 address'],
        ['INSTALL_GUIDE_URL=https://example.com/guide#top', 'a fragment'],
        ['STAGING_ZONE=ptbk.link', 'a staging domain (ptbk.link is committed, not filled in)'],
        ['ENGINE_DOMAIN=engines.ptbk.link', 'an engine domain (it is engines.ptbk.link)'],
        ['CHALLENGE_ZONE=acme.example', 'a challenge zone (lego writes into ptbk.link)'],
    ] as const) {
        it(`refuses ${why}`, () => {
            assert.throws(() => parseStagingEnv(text), StagingValuesError);
        });
    }
});
