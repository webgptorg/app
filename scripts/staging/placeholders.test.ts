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
    CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    SECURITY_CONTACT: 'security@ops.example',
    OPS_EMAIL: 'ops@ops.example',
    ABUSE_EMAIL: 'abuse@ops.example',
    ADMIN_NAME: 'seb',
    ADMIN_SSH_PUBLIC_KEY: 'sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t seb@laptop',
    ADMIN_CIDRS: '203.0.113.7/32,2001:db8::/64',
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
    it('leaves only the placeholders that wait on the engine team', () => {
        assert.deepEqual(result.left.map(({ placeholder }) => placeholder).sort(), [
            '<installer-sha256>',
            '<installer-url>',
        ]);
    });

    it('fills wrangler.jsonc env.staging consistently with the tfvars', () => {
        const staging = stagingOf(result.files.wrangler);
        assert.match(staging, /"pattern": "app\.ptbk\.link", "custom_domain": true/);
        assert.match(staging, /"DASHBOARD_ORIGIN": "https:\/\/app\.ptbk\.link"/);
        assert.match(staging, /"relayId": "relay-fsn\.ptbk\.link"/);
        assert.match(staging, /"ENGINE_DOMAIN": "engines\.ptbk\.link"/);
        assert.match(staging, /"database_id": "01234567-89ab-cdef-0123-456789abcdef"/);
        assert.match(staging, /"EMAIL_FROM": "no-reply@mail\.ptbk\.link"/);
        assert.match(staging, /"accountId": "0123456789abcdef0123456789abcdef"/);
        assert.ok(staging.includes(`"INSTALL_GUIDE_URL": "${DEFAULT_INSTALL_GUIDE_URL}"`));
        assert.match(result.files.relayTfvars, /registry_url\s+= "https:\/\/app\.ptbk\.link"/);
        assert.match(result.files.cloudflareTfvars, /email_sending_domain = "mail\.ptbk\.link"/);
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

    it('writes the admin and every allowed network into the relay tfvars', () => {
        assert.ok(result.files.relayTfvars.includes(`"seb" = ["${ALL.ADMIN_SSH_PUBLIC_KEY ?? ''}"]`));
        assert.match(result.files.relayTfvars, /ssh_allowlist = \["203\.0\.113\.7\/32", "2001:db8::\/64"\]/);
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
        const values = parseStagingEnv('# staging\n\nADMIN_NAME=seb\nRELAY_IPV4=\nOPS_EMAIL="ops@ops.example"\n');
        assert.deepEqual(values, { ADMIN_NAME: 'seb', OPS_EMAIL: 'ops@ops.example' });
    });

    for (const [text, why] of [
        ['OPS_EMAIL', 'not KEY=value'],
        ['STRIPE_SECRET_KEY=sk_test_x', 'an unknown key (no secrets belong here)'],
        ['CLOUDFLARE_ACCOUNT_ID=<staging-account-id>', 'a placeholder'],
        ['OPS_EMAIL=ops@Example.COM', 'an upper-case address'],
        ['ADMIN_SSH_PUBLIC_KEY=ssh-rsa AAAAB3Nza seb', 'an RSA key, which the relay refuses'],
        ['ADMIN_SSH_PUBLIC_KEY=ssh-ed25519 AAAA "x"', 'a quote, which would break out of the HCL string'],
        ['ADMIN_CIDRS=203.0.113.7', 'a bare address'],
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
