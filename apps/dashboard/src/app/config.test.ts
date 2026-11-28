import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { syntheticStripeKey, syntheticWebhookSecret, TEST_OFF_PLAN, TEST_PLANS } from '../testing/billing-fixtures';
import { TEST_ENGINE_INSTALLATION, TEST_INSTALL_VARS } from '../testing/install-fixtures';
import { syntheticLicenseSecret } from '../testing/licensing-fixtures';
import { readWranglerConfig } from '../testing/wrangler-config';
import { DEFAULT_THRESHOLDS } from '../domain/monitoring/alert-rules';
import {
    ConfigError,
    DEFAULT_ABUSE_MONITORING,
    DEV_MEMBER_KEY,
    DEV_RATE_LIMIT_HMAC_KEY,
    parseConfig,
    relayName,
} from './config';

const devVars = {
    ENVIRONMENT: 'dev',
    DASHBOARD_ORIGIN: 'https://app.ptbk.test',
    ENGINE_DOMAIN: 'engines.ptbk.test',
    RELAYS: [{ relayId: 'relay-1.ptbk.test', region: 'eu-central' }],
    ...TEST_INSTALL_VARS,
    ADAPTERS: { email: 'fake', billing: 'fake', rateLimit: 'memory' },
    EMAIL_FROM: 'no-reply@ptbk.test',
    ABUSE_EMAIL: 'abuse@ptbk.test',
    RATE_LIMIT_HMAC_KEY: DEV_RATE_LIMIT_HMAC_KEY,
    BILLING_PLANS: TEST_PLANS,
};
const STAGING_KEY = 'c3RhZ2luZy1zZWNyZXQta2V5LWZvci1yYXRlLWxpbWl0cy0zMmI';
const stagingVars = {
    ...devVars,
    ENVIRONMENT: 'staging',
    ADAPTERS: { email: 'cloudflare', billing: 'stripe', rateLimit: 'workers' },
    RATE_LIMIT_HMAC_KEY: STAGING_KEY,
    STRIPE_SECRET_KEY: syntheticStripeKey(),
    STRIPE_WEBHOOK_SECRET: syntheticWebhookSecret(),
};
class FakeBinding {
    readonly kind = 'binding';
}
const bindings = { DB: new FakeBinding(), ASSETS: new FakeBinding() };

function without(vars: object, ...names: readonly string[]): Record<string, unknown> {
    return Object.fromEntries(Object.entries(vars).filter(([name]) => !names.includes(name)));
}

function failedPaths(env: object): readonly string[] {
    try {
        parseConfig(env);
    } catch (error) {
        if (error instanceof ConfigError) {
            return error.paths;
        }
        throw error;
    }
    throw new Error('expected parseConfig to fail');
}

describe('parseConfig', () => {
    it('accepts reviewed engine installation without legacy templates and requires HTTPS for its pairing URLs', () => {
        const vars = { ...without(devVars, 'INSTALL_COMMANDS'), ENGINE_INSTALLATION: TEST_ENGINE_INSTALLATION };
        const config = parseConfig({ ...bindings, ...vars });
        expect(config.engineInstallation).toEqual(TEST_ENGINE_INSTALLATION);
        expect(Object.isFrozen(config.engineInstallation)).toBe(true);
        expect(config.installCommands).toEqual([]);
        expect(failedPaths({ ...bindings, ...vars, DASHBOARD_ORIGIN: 'http://localhost:5173' })).toEqual([
            'INSTALL_COMMANDS',
        ]);
        expect(
            failedPaths({
                ...bindings,
                ...vars,
                ENGINE_INSTALLATION: { ...TEST_ENGINE_INSTALLATION, version: 'latest' },
            }),
        ).toEqual(['ENGINE_INSTALLATION.version']);
    });
    it('accepts a DigitalOcean signup referral and only links to the official referral service', () => {
        const offer = { clientId: 'public-client', referralUrl: 'https://m.do.co/c/example123' };
        const config = parseConfig({ ...bindings, ...devVars, VPS_DIGITALOCEAN: offer });
        expect(config.digitalOcean).toEqual(offer);
        expect(Object.isFrozen(config.digitalOcean)).toBe(true);
        expect(
            failedPaths({ ...bindings, ...devVars, VPS_DIGITALOCEAN: { referralUrl: 'https://example.org/' } }),
        ).toEqual(['VPS_DIGITALOCEAN.referralUrl']);
    });

    it('parses a complete dev configuration into a frozen object', () => {
        const { billing, ...config } = parseConfig({ ...bindings, ...devVars });
        expect(config).toEqual({
            environment: 'dev',
            dashboardOrigin: 'https://app.ptbk.test',
            engineDomain: 'engines.ptbk.test',
            relays: [{ relayId: 'relay-1.ptbk.test', region: 'eu-central' }],
            installCommands: TEST_INSTALL_VARS.INSTALL_COMMANDS,
            installGuideUrl: 'https://docs.ptbk.test/engine/installation',
            adapters: { email: 'fake', billing: 'fake', rateLimit: 'memory' },
            emailFrom: 'no-reply@ptbk.test',
            abuseEmail: 'abuse@ptbk.test',
            rateLimitHmacKey: new TextEncoder().encode('dev-only-rate-limit-key-not-secret'),
            memberKeySeed: null,
            heartbeat: { intervalS: 60, missedLimit: 3, graceS: 15, perEngineLimit: 5 },
            linkCodeTtlMs: 30 * 24 * 3_600_000,
            stripeSecretKey: null,
            stripeWebhookSecret: null,
            monitoring: null,
            abuseMonitoring: { ...DEFAULT_ABUSE_MONITORING, certSpotterApiKey: null, webRiskApiKey: null },
        });
        expect(billing.adapter === 'fake' ? billing.plans.plans.map((plan) => plan.id) : null).toEqual([
            'starter',
            'scale',
        ]);
        expect(Object.isFrozen(parseConfig({ ...bindings, ...devVars }))).toBe(true);
        expect(Object.isFrozen(config.relays[0])).toBe(true);
        expect(Object.isFrozen(config.adapters)).toBe(true);
        expect(Object.isFrozen(config.heartbeat)).toBe(true);
        expect(Object.isFrozen(config.installCommands)).toBe(true);
        expect(Object.isFrozen(config.installCommands[0])).toBe(true);
    });

    it('takes the heartbeat timing from HEARTBEAT, filling in the defaults', () => {
        expect(parseConfig({ ...bindings, ...devVars, HEARTBEAT: { intervalS: 15 } }).heartbeat).toEqual({
            intervalS: 15,
            missedLimit: 3,
            graceS: 15,
            perEngineLimit: 5,
        });
    });

    it.each([
        ['an unknown member', { intervalS: 60, debug: true }],
        ['an interval below 5 s', { intervalS: 4 }],
        ['a fractional limit', { missedLimit: 2.5 }],
        ['a per-engine limit the interval would exceed', { intervalS: 5, perEngineLimit: 11 }],
    ])('refuses a HEARTBEAT with %s', (_, heartbeat) => {
        expect(failedPaths({ ...bindings, ...devVars, HEARTBEAT: heartbeat })[0]).toMatch(/^HEARTBEAT/);
    });

    it('takes the link code lifetime from LINK_CODE_TTL_S', () => {
        expect(parseConfig({ ...bindings, ...devVars, LINK_CODE_TTL_S: 30 }).linkCodeTtlMs).toBe(30_000);
        expect(parseConfig({ ...bindings, ...devVars, LINK_CODE_TTL_S: 30 * 86_400 }).linkCodeTtlMs).toBe(
            30 * 86_400_000,
        );
    });

    it.each([
        ['shorter than 10 s', 9],
        ['longer than 30 days', 30 * 86_400 + 1],
        ['fractional', 30.5],
        ['a string', '30'],
    ])('refuses a LINK_CODE_TTL_S that is %s', (_, ttl) => {
        expect(failedPaths({ ...bindings, ...devVars, LINK_CODE_TTL_S: ttl })).toEqual(['LINK_CODE_TTL_S']);
    });

    it('accepts real adapters outside dev', () => {
        expect(parseConfig({ ...bindings, ...stagingVars }).environment).toBe('staging');
    });

    it.each([
        'ENVIRONMENT',
        'DASHBOARD_ORIGIN',
        'ENGINE_DOMAIN',
        'RELAYS',
        'INSTALL_COMMANDS',
        'INSTALL_GUIDE_URL',
        'ADAPTERS',
        'EMAIL_FROM',
        'ABUSE_EMAIL',
        'RATE_LIMIT_HMAC_KEY',
        'BILLING_PLANS',
    ])('fails closed without %s', (name) => {
        const vars = Object.fromEntries(Object.entries({ ...bindings, ...devVars }).filter(([key]) => key !== name));
        expect(failedPaths(vars)).toEqual([name]);
    });

    it('fails closed on an unknown var', () => {
        expect(failedPaths({ ...bindings, ...devVars, ADMIN_BYPASS: 'true' })).toEqual(['ADMIN_BYPASS']);
        expect(failedPaths({ ...bindings, ...devVars, EXTRA: { nested: true } })).toEqual(['EXTRA']);
    });

    it('leaves runtime bindings to the composition root', () => {
        expect(parseConfig({ ...devVars, DB: new FakeBinding(), SELF: () => undefined }).environment).toBe('dev');
    });

    it('fails closed on an unknown value', () => {
        expect(failedPaths({ ...bindings, ...devVars, ENVIRONMENT: 'qa' })).toEqual(['ENVIRONMENT']);
        expect(failedPaths({ ...bindings, ...devVars, ADAPTERS: { ...devVars.ADAPTERS, sms: 'fake' } })).toEqual([
            'ADAPTERS.sms',
        ]);
    });

    it.each(['staging', 'production'])('refuses the fake billing adapter in %s', (environment) => {
        expect(
            failedPaths({
                ...bindings,
                ...stagingVars,
                ENVIRONMENT: environment,
                ADAPTERS: { ...stagingVars.ADAPTERS, billing: 'fake' },
            }),
        ).toEqual(['ADAPTERS.billing']);
    });

    it.each([
        ['email', 'fake'],
        ['rateLimit', 'memory'],
    ])('refuses %s=%s in production', (port, adapter) => {
        const env = {
            ...bindings,
            ...stagingVars,
            ENVIRONMENT: 'production',
            ADAPTERS: { ...stagingVars.ADAPTERS, [port]: adapter },
        };
        expect(failedPaths(env)).toEqual([`ADAPTERS.${port}`]);
    });

    describe('billing off', () => {
        const stagingOff = {
            ...without(stagingVars, 'BILLING_PLANS', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'),
            ADAPTERS: { ...stagingVars.ADAPTERS, billing: 'off' },
            BILLING_OFF_PLAN: TEST_OFF_PLAN,
        };

        const devOff = {
            ...without(devVars, 'BILLING_PLANS'),
            ADAPTERS: { ...devVars.ADAPTERS, billing: 'off' },
            BILLING_OFF_PLAN: TEST_OFF_PLAN,
        };

        it.each([
            ['dev', devOff],
            ['staging', stagingOff],
        ])('runs in %s without Stripe secrets or Stripe IDs', (_, vars) => {
            const config = parseConfig({ ...bindings, ...vars });
            expect(config.adapters.billing).toBe('off');
            expect(config.billing).toEqual({ adapter: 'off', grant: TEST_OFF_PLAN });
            expect(Object.isFrozen(config.billing)).toBe(true);
            expect(config.stripeSecretKey).toBeNull();
        });

        it('refuses billing off in production, which charges', () => {
            expect(failedPaths({ ...bindings, ...stagingOff, ENVIRONMENT: 'production' })).toEqual([
                'ADAPTERS.billing',
            ]);
            const staged = { ...stagingOff, BILLING_PLANS: TEST_PLANS, STRIPE_SECRET_KEY: syntheticStripeKey('live') };
            expect(failedPaths({ ...bindings, ...staged, ENVIRONMENT: 'production' })).toEqual(['ADAPTERS.billing']);
        });

        it('requires BILLING_OFF_PLAN', () => {
            expect(failedPaths({ ...bindings, ...without(stagingOff, 'BILLING_OFF_PLAN') })).toEqual([
                'BILLING_OFF_PLAN',
            ]);
        });

        it('refuses BILLING_OFF_PLAN once billing is on', () => {
            expect(failedPaths({ ...bindings, ...stagingVars, BILLING_OFF_PLAN: TEST_OFF_PLAN })).toEqual([
                'BILLING_OFF_PLAN',
            ]);
            expect(failedPaths({ ...bindings, ...devVars, BILLING_OFF_PLAN: TEST_OFF_PLAN })).toEqual([
                'BILLING_OFF_PLAN',
            ]);
        });

        it.each([
            ['an unknown feature', { ...TEST_OFF_PLAN, features: ['engines.create', 'everything'] }],
            ['an unknown quota', { ...TEST_OFF_PLAN, quotas: { ...TEST_OFF_PLAN.quotas, 'seats.max': 1 } }],
            ['a missing quota', { ...TEST_OFF_PLAN, quotas: { 'engines.max': 1 } }],
            ['a negative limit', { ...TEST_OFF_PLAN, quotas: { ...TEST_OFF_PLAN.quotas, 'engines.max': -1 } }],
            ['a plan name', { ...TEST_OFF_PLAN, id: 'standard' }],
        ])('refuses a BILLING_OFF_PLAN with %s', (_, plan) => {
            expect(failedPaths({ ...bindings, ...stagingOff, BILLING_OFF_PLAN: plan })[0]).toMatch(/^BILLING_OFF_PLAN/);
        });

        it('lets the Stripe catalogue and secrets be staged ahead of switching on, still validated', () => {
            const staged = {
                ...bindings,
                ...stagingOff,
                BILLING_PLANS: TEST_PLANS,
                STRIPE_SECRET_KEY: syntheticStripeKey(),
                STRIPE_WEBHOOK_SECRET: syntheticWebhookSecret(),
            };
            expect(parseConfig(staged).billing.adapter).toBe('off');
            expect(failedPaths({ ...staged, BILLING_PLANS: { plans: [] } })).toEqual(['BILLING_PLANS.none']);
            expect(failedPaths({ ...staged, STRIPE_SECRET_KEY: syntheticStripeKey('live') })).toEqual([
                'STRIPE_SECRET_KEY',
            ]);
        });

        it('requires BILLING_PLANS with billing on', () => {
            expect(failedPaths({ ...bindings, ...without(stagingVars, 'BILLING_PLANS') })).toEqual(['BILLING_PLANS']);
        });
    });

    describe('billing website', () => {
        const secret = syntheticLicenseSecret();
        const stagingWebsite = {
            ...without(stagingVars, 'BILLING_PLANS', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'),
            ADAPTERS: { ...stagingVars.ADAPTERS, billing: 'website' },
            WEBSITE_HANDOFF_URL: 'https://www.ptbk.io/cs/app/pripojit',
            PROMPTBOOK_APP_LICENSE_SECRET: secret,
        };

        it('runs without a plan catalogue or Stripe, against the production website by default', () => {
            const config = parseConfig({ ...bindings, ...stagingWebsite, ENVIRONMENT: 'production' });
            expect(config.billing).toEqual({
                adapter: 'website',
                websiteOrigin: 'https://www.ptbk.io',
                handoffUrl: 'https://www.ptbk.io/cs/app/pripojit',
                licenseSecret: secret,
                enforcement: 'advisory',
            });
            expect(Object.isFrozen(config.billing)).toBe(true);
        });

        it('takes another https website origin, for staging', () => {
            const config = parseConfig({
                ...bindings,
                ...stagingWebsite,
                WEBSITE_ORIGIN: 'https://staging.ptbk.io/',
                WEBSITE_HANDOFF_URL: 'https://staging.ptbk.io/app?from=app',
            });
            expect(config.billing.adapter === 'website' ? config.billing.websiteOrigin : null).toBe(
                'https://staging.ptbk.io',
            );
        });

        it.each([
            ['plain http', 'http://www.ptbk.io'],
            ['a path', 'https://www.ptbk.io/cs'],
            ['not a URL', 'www.ptbk.io'],
        ])('refuses a website origin with %s', (_, origin) => {
            expect(failedPaths({ ...bindings, ...stagingWebsite, WEBSITE_ORIGIN: origin })).toEqual(['WEBSITE_ORIGIN']);
        });

        it('requires a handoff page on the website origin, without a guessed default', () => {
            expect(failedPaths({ ...bindings, ...without(stagingWebsite, 'WEBSITE_HANDOFF_URL') })).toEqual([
                'WEBSITE_HANDOFF_URL',
            ]);
            for (const url of ['https://evil.example/app', 'http://www.ptbk.io/app', 'https://www.ptbk.io/app#x']) {
                expect(failedPaths({ ...bindings, ...stagingWebsite, WEBSITE_HANDOFF_URL: url })).toEqual([
                    'WEBSITE_HANDOFF_URL',
                ]);
            }
        });

        it('refuses to start without the website credential, or with a weak one', () => {
            expect(failedPaths({ ...bindings, ...without(stagingWebsite, 'PROMPTBOOK_APP_LICENSE_SECRET') })).toEqual([
                'PROMPTBOOK_APP_LICENSE_SECRET',
            ]);
            expect(
                failedPaths({ ...bindings, ...stagingWebsite, PROMPTBOOK_APP_LICENSE_SECRET: 'short-and-guessable' }),
            ).toEqual(['PROMPTBOOK_APP_LICENSE_SECRET']);
        });

        it('keeps licences advisory unless enforcement is asked for, and only enforces with website billing', () => {
            const enforced = parseConfig({ ...bindings, ...stagingWebsite, LICENSE_ENFORCEMENT: 'enforce' });
            expect(enforced.billing.adapter === 'website' ? enforced.billing.enforcement : null).toBe('enforce');
            expect(failedPaths({ ...bindings, ...stagingWebsite, LICENSE_ENFORCEMENT: 'strict' })).toEqual([
                'LICENSE_ENFORCEMENT',
            ]);
            expect(failedPaths({ ...bindings, ...stagingVars, LICENSE_ENFORCEMENT: 'enforce' })).toEqual([
                'LICENSE_ENFORCEMENT',
            ]);
            expect(parseConfig({ ...bindings, ...stagingVars, LICENSE_ENFORCEMENT: 'advisory' }).billing.adapter).toBe(
                'stripe',
            );
        });

        it('enforces licences in no committed environment', () => {
            const vars = z.object({ vars: z.record(z.string(), z.unknown()) });
            const wrangler = vars.extend({ env: z.record(z.string(), vars) }).parse(readWranglerConfig());
            for (const config of [wrangler, ...Object.values(wrangler.env)]) {
                expect(config.vars['LICENSE_ENFORCEMENT'] ?? 'advisory').toBe('advisory');
            }
        });

        it('lets the credential be staged, validated and unused, under another adapter', () => {
            expect(
                parseConfig({ ...bindings, ...stagingVars, PROMPTBOOK_APP_LICENSE_SECRET: secret }).billing.adapter,
            ).toBe('stripe');
        });
    });

    it('requires both Stripe secrets with the stripe billing adapter, and neither with the fake', () => {
        const withoutSecrets = Object.fromEntries(
            Object.entries(stagingVars).filter(([name]) => !name.startsWith('STRIPE_')),
        );
        expect(failedPaths({ ...bindings, ...withoutSecrets })).toEqual(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);
        const secret = syntheticWebhookSecret();
        const config = parseConfig({ ...bindings, ...stagingVars, STRIPE_WEBHOOK_SECRET: secret });
        expect(config.stripeWebhookSecret).toBe(secret);
        expect(parseConfig({ ...bindings, ...devVars, STRIPE_WEBHOOK_SECRET: secret }).stripeWebhookSecret).toBe(
            secret,
        );
    });

    it('allows live Stripe keys only in production', () => {
        const live = syntheticStripeKey('live');
        expect(failedPaths({ ...bindings, ...stagingVars, STRIPE_SECRET_KEY: live })).toEqual(['STRIPE_SECRET_KEY']);
        expect(failedPaths({ ...bindings, ...devVars, STRIPE_SECRET_KEY: live })).toEqual(['STRIPE_SECRET_KEY']);
        const production = { ...bindings, ...stagingVars, ENVIRONMENT: 'production', STRIPE_SECRET_KEY: live };
        expect(parseConfig(production).stripeSecretKey).toBe(live);
        expect(failedPaths({ ...bindings, ...stagingVars, STRIPE_SECRET_KEY: 'pk_test_publishable' })).toEqual([
            'STRIPE_SECRET_KEY',
        ]);
    });

    it('rejects an invalid plan catalogue at parse', () => {
        const [starter] = TEST_PLANS.plans;
        expect(
            failedPaths({
                ...bindings,
                ...devVars,
                BILLING_PLANS: { ...TEST_PLANS, plans: [starter, { ...starter, stripePriceId: 'price_other' }] },
            }),
        ).toEqual(['BILLING_PLANS.plans.1.id']);
        expect(failedPaths({ ...bindings, ...devVars, BILLING_PLANS: { plans: TEST_PLANS.plans } })).toEqual([
            'BILLING_PLANS.none',
        ]);
    });

    it('requires an https origin outside dev and a bare origin everywhere', () => {
        expect(failedPaths({ ...bindings, ...stagingVars, DASHBOARD_ORIGIN: 'http://app.ptbk.test' })).toEqual([
            'DASHBOARD_ORIGIN',
        ]);
        expect(failedPaths({ ...bindings, ...devVars, DASHBOARD_ORIGIN: 'https://app.ptbk.test/x' })).toEqual([
            'DASHBOARD_ORIGIN',
        ]);
    });

    it('refuses the committed dev HMAC key outside dev, and a key shorter than 256 bits anywhere', () => {
        expect(failedPaths({ ...bindings, ...stagingVars, RATE_LIMIT_HMAC_KEY: DEV_RATE_LIMIT_HMAC_KEY })).toEqual([
            'RATE_LIMIT_HMAC_KEY',
        ]);
        expect(failedPaths({ ...bindings, ...devVars, RATE_LIMIT_HMAC_KEY: 'c2hvcnQ' })).toEqual([
            'RATE_LIMIT_HMAC_KEY',
        ]);
        expect(parseConfig({ ...bindings, ...stagingVars }).rateLimitHmacKey).toHaveLength(38);
    });

    it('takes an optional member key, refusing the committed dev one outside dev', () => {
        expect(parseConfig({ ...bindings, ...stagingVars }).memberKeySeed).toBeNull();
        expect(parseConfig({ ...bindings, ...devVars, MEMBER_KEY: DEV_MEMBER_KEY }).memberKeySeed).toHaveLength(32);
        expect(failedPaths({ ...bindings, ...stagingVars, MEMBER_KEY: DEV_MEMBER_KEY })).toEqual(['MEMBER_KEY']);
        expect(failedPaths({ ...bindings, ...devVars, MEMBER_KEY: 'c2hvcnQ' })).toEqual(['MEMBER_KEY']);
    });

    it('requires a plain sender address', () => {
        expect(failedPaths({ ...bindings, ...devVars, EMAIL_FROM: 'Promptbook' })).toEqual(['EMAIL_FROM']);
    });

    it('validates relays as hostnames with a region label', () => {
        expect(failedPaths({ ...bindings, ...devVars, RELAYS: [] })).toEqual(['RELAYS']);
        expect(failedPaths({ ...bindings, ...devVars, RELAYS: [{ relayId: '10.0.0.1', region: 'eu' }] })).toEqual([
            'RELAYS.0.relayId',
        ]);
        expect(failedPaths({ ...bindings, ...devVars, RELAYS: [{ relayId: 'relay', region: 'eu' }] })).toEqual([
            'RELAYS.0.relayId',
        ]);
        expect(
            failedPaths({ ...bindings, ...devVars, RELAYS: [{ relayId: 'r.ptbk.test', region: 'EU Central' }] }),
        ).toEqual(['RELAYS.0.region']);
        const relay = { relayId: 'r.ptbk.test', region: 'eu' };
        expect(failedPaths({ ...bindings, ...devVars, RELAYS: [relay, { ...relay, relayId: 'R.ptbk.test' }] })).toEqual(
            ['RELAYS'],
        );
    });

    it('needs the link code placeholder exactly once in every install command', () => {
        const [installer, compose, connect] = TEST_INSTALL_VARS.INSTALL_COMMANDS;
        for (const template of [
            'bun run dev:link',
            'link {linkCode} {linkCode}',
            '',
            'link {linkCode}\n{linkCode}',
            "link '{linkUrl}' {linkCode}",
            "link '{linkUrl}' '{linkUrl}'",
        ]) {
            expect(
                failedPaths({
                    ...bindings,
                    ...devVars,
                    INSTALL_COMMANDS: [installer, { ...compose, template }, connect],
                }),
            ).toEqual(['INSTALL_COMMANDS.1.template']);
        }
    });

    it('takes the link URL placeholder in place of the code, on an https origin only', () => {
        const [installer, compose, connect] = TEST_INSTALL_VARS.INSTALL_COMMANDS;
        const tabs = [installer, compose, { ...connect, template: "ptbk connect --link '{linkUrl}'" }];
        expect(parseConfig({ ...bindings, ...devVars, INSTALL_COMMANDS: tabs }).installCommands[2]?.template).toBe(
            "ptbk connect --link '{linkUrl}'",
        );
        expect(
            failedPaths({ ...bindings, ...devVars, DASHBOARD_ORIGIN: 'http://localhost:5173', INSTALL_COMMANDS: tabs }),
        ).toEqual(['INSTALL_COMMANDS']);
        const legacy = Object.fromEntries(
            Object.entries({
                ...devVars,
                DASHBOARD_ORIGIN: 'http://localhost:5173',
                INSTALL_COMMAND: '{linkUrl}',
            }).filter(([key]) => key !== 'INSTALL_COMMANDS'),
        );
        expect(failedPaths({ ...bindings, ...legacy })).toEqual(['INSTALL_COMMANDS']);
    });

    it('refuses an empty tab list, an unknown or repeated path and a malformed tab', () => {
        const [installer, compose] = TEST_INSTALL_VARS.INSTALL_COMMANDS;
        const withTabs = (tabs: readonly object[]) => failedPaths({ ...bindings, ...devVars, INSTALL_COMMANDS: tabs });
        expect(withTabs([])).toEqual(['INSTALL_COMMANDS']);
        expect(withTabs([installer, { ...compose, id: 'npm' }])).toEqual(['INSTALL_COMMANDS.1.id']);
        expect(withTabs([installer, { ...compose, id: 'installer' }])).toEqual(['INSTALL_COMMANDS']);
        expect(withTabs([{ ...installer, labelKey: 'engines_new_title' }])).toEqual(['INSTALL_COMMANDS.0.labelKey']);
        expect(withTabs([{ ...installer, docsAnchor: '#Install' }])).toEqual(['INSTALL_COMMANDS.0.docsAnchor']);
        expect(withTabs([{ ...installer, html: '<b>' }])).toEqual(['INSTALL_COMMANDS.0.html']);
    });

    it("accepts every environment's committed install tabs", () => {
        const vars = z.object({ vars: z.object({ INSTALL_COMMANDS: z.array(z.unknown()) }) });
        const wrangler = vars.extend({ env: z.record(z.string(), vars) }).parse(readWranglerConfig());
        for (const config of [wrangler, ...Object.values(wrangler.env)]) {
            const { INSTALL_COMMANDS } = config.vars;
            expect(parseConfig({ ...bindings, ...devVars, INSTALL_COMMANDS }).installCommands).toEqual(
                INSTALL_COMMANDS,
            );
        }
        expect(Object.keys(wrangler.env)).toEqual(['staging', 'production']);
    });

    it('still reads the single INSTALL_COMMAND as the installer tab, but not next to INSTALL_COMMANDS', () => {
        const legacy = Object.fromEntries(
            Object.entries({ ...devVars, INSTALL_COMMAND: 'bun run dev:link {linkCode}' }).filter(
                ([key]) => key !== 'INSTALL_COMMANDS',
            ),
        );
        expect(parseConfig({ ...bindings, ...legacy }).installCommands).toEqual([
            {
                id: 'installer',
                labelKey: 'docker-server',
                template: 'bun run dev:link {linkCode}',
                docsAnchor: '1-the-installer-recommended',
            },
        ]);
        expect(failedPaths({ ...bindings, ...legacy, INSTALL_COMMAND: 'link' })).toEqual(['INSTALL_COMMAND']);
        expect(failedPaths({ ...bindings, ...devVars, INSTALL_COMMAND: 'link {linkCode}' })).toEqual([
            'INSTALL_COMMAND',
        ]);
    });

    it('needs an https install guide without a fragment', () => {
        for (const url of ['http://docs.ptbk.test/install', 'https://docs.ptbk.test/install#top', 'docs', '']) {
            expect(failedPaths({ ...bindings, ...devVars, INSTALL_GUIDE_URL: url })).toEqual(['INSTALL_GUIDE_URL']);
        }
    });

    it('never puts a value into the error', () => {
        const error = (() => {
            try {
                parseConfig({ ...bindings, ...devVars, ENGINE_DOMAIN: 'secret-value_!' });
            } catch (caught) {
                return caught;
            }
            return undefined;
        })();
        expect(error).toBeInstanceOf(ConfigError);
        expect(String(error)).not.toContain('secret-value');
    });

    describe('MONITORING (I-04)', () => {
        const tokenA = `ptbk_mt_${'a'.repeat(43)}`;
        const tokenB = `ptbk_mt_${'b'.repeat(43)}`;
        const twoRelays = [
            { relayId: 'relay-1.ptbk.test', region: 'eu-central' },
            { relayId: 'relay-2.ptbk.test', region: 'eu-west' },
        ];
        const tokens = JSON.stringify({ 'relay-1.ptbk.test': tokenA, 'relay-2.ptbk.test': tokenB });
        const analytics = { accountId: 'f'.repeat(32), dataset: 'ptbk_ops_staging' };
        const analyticsToken = 'T'.repeat(40);
        const monitored = {
            ...bindings,
            ...devVars,
            RELAYS: twoRelays,
            MONITORING: { opsEmail: 'ops@ptbk.test' },
            RELAY_METRICS_TOKENS: tokens,
        };

        it('leaves monitoring off without MONITORING', () => {
            expect(parseConfig({ ...bindings, ...devVars, RELAY_METRICS_TOKENS: tokens }).monitoring).toBeNull();
        });

        it('names each relay by its first label and pairs it with its token', () => {
            const { monitoring } = parseConfig(monitored);
            expect(monitoring).toEqual({
                opsEmail: 'ops@ptbk.test',
                thresholds: DEFAULT_THRESHOLDS,
                probeTimeoutMs: 10_000,
                relays: [
                    { relayId: 'relay-1.ptbk.test', name: 'relay-1', metricsToken: tokenA },
                    { relayId: 'relay-2.ptbk.test', name: 'relay-2', metricsToken: tokenB },
                ],
                analytics: null,
            });
            expect(Object.isFrozen(monitoring?.relays[0])).toBe(true);
            expect(relayName('relay')).toBe('relay');
        });

        it('overrides single thresholds and keeps the other defaults', () => {
            const { monitoring } = parseConfig({
                ...monitored,
                MONITORING: { opsEmail: 'ops@ptbk.test', thresholds: { unreachableChecks: 3 }, probeTimeoutMs: 5000 },
            });
            expect(monitoring?.thresholds).toEqual({ ...DEFAULT_THRESHOLDS, unreachableChecks: 3 });
            expect(monitoring?.probeTimeoutMs).toBe(5000);
        });

        it.each([
            ['a zero threshold', { thresholds: { cronFailures: 0 } }],
            ['a percentage above 100', { thresholds: { tunnelDropPercent: 101 } }],
            ['an unknown threshold', { thresholds: { anything: 1 } }],
            ['a short probe timeout', { probeTimeoutMs: 10 }],
        ])('refuses %s', (_, extra) => {
            expect(failedPaths({ ...monitored, MONITORING: { opsEmail: 'ops@ptbk.test', ...extra } })[0]).toMatch(
                /^MONITORING/,
            );
        });

        it.each([
            ['missing', undefined],
            ['not JSON', 'nope'],
            ['short of a relay', JSON.stringify({ 'relay-1.ptbk.test': tokenA })],
            ['naming another relay', JSON.stringify({ 'relay-1.ptbk.test': tokenA, 'relay-3.ptbk.test': tokenB })],
            [
                'holding a registry token',
                JSON.stringify({ 'relay-1.ptbk.test': tokenA, 'relay-2.ptbk.test': `ptbk_rt_${'b'.repeat(43)}` }),
            ],
        ])('refuses RELAY_METRICS_TOKENS %s, without quoting it', (_, value) => {
            const env = { ...monitored, RELAY_METRICS_TOKENS: value };
            expect(failedPaths(env)[0]).toMatch(/^RELAY_METRICS_TOKENS/);
            try {
                parseConfig(env);
            } catch (error) {
                expect(String(error)).not.toContain(tokenA);
            }
        });

        it('refuses two relays with the same first label', () => {
            expect(
                failedPaths({
                    ...monitored,
                    RELAYS: [
                        { relayId: 'relay-1.ptbk.test', region: 'eu-central' },
                        { relayId: 'relay-1.ptbk.example', region: 'eu-west' },
                    ],
                    RELAY_METRICS_TOKENS: JSON.stringify({
                        'relay-1.ptbk.test': tokenA,
                        'relay-1.ptbk.example': tokenB,
                    }),
                }),
            ).toEqual(['RELAYS']);
        });

        it('needs the analytics account, dataset and token outside dev, and reads them', () => {
            const staging = { ...monitored, ...stagingVars, RELAYS: twoRelays };
            expect(failedPaths(staging)).toEqual(['ANALYTICS', 'ANALYTICS_API_TOKEN']);
            expect(
                parseConfig({ ...staging, ANALYTICS: analytics, ANALYTICS_API_TOKEN: analyticsToken }).monitoring
                    ?.analytics,
            ).toEqual({ ...analytics, token: analyticsToken });
            expect(
                failedPaths({
                    ...staging,
                    ANALYTICS: { ...analytics, dataset: 'ops; DROP' },
                    ANALYTICS_API_TOKEN: analyticsToken,
                }),
            ).toEqual(['ANALYTICS.dataset']);
            expect(parseConfig({ ...monitored, ANALYTICS: analytics }).monitoring?.analytics).toBeNull();
        });
    });

    describe('ABUSE_MONITORING (I-05)', () => {
        it('overrides the defaults field by field and reads the Cert Spotter key', () => {
            const fingerprint = 'c'.repeat(64);
            const config = parseConfig({
                ...bindings,
                ...devVars,
                ABUSE_MONITORING: {
                    ctSources: ['certspotter', 'certspotter'],
                    allowedIssuers: ['Google Trust Services'],
                    issuanceSpike: { limit: 5, days: 3 },
                    publicFace: { fingerprints: [fingerprint] },
                },
                CERTSPOTTER_API_KEY: 'k_123456789',
                WEB_RISK_API_KEY: `AIza${'a1_-'.repeat(8)}abc`,
            }).abuseMonitoring;
            expect(config).toEqual({
                ctSources: ['certspotter'],
                allowedIssuers: ['Google Trust Services'],
                issuanceSpike: { limit: 5, days: 3 },
                publicFace: { fingerprints: [fingerprint], perRun: 30 },
                certSpotterApiKey: 'k_123456789',
                webRiskApiKey: `AIza${'a1_-'.repeat(8)}abc`,
            });
            expect(
                parseConfig({ ...bindings, ...devVars, ABUSE_MONITORING: { publicFace: { perRun: 50 } } })
                    .abuseMonitoring.publicFace,
            ).toEqual({ fingerprints: DEFAULT_ABUSE_MONITORING.publicFace.fingerprints, perRun: 50 });
        });

        it('refuses an unknown source, a malformed fingerprint or key, and unknown fields', () => {
            expect(failedPaths({ ...bindings, ...devVars, ABUSE_MONITORING: { ctSources: ['google'] } })).toEqual([
                'ABUSE_MONITORING.ctSources.0',
            ]);
            expect(
                failedPaths({ ...bindings, ...devVars, ABUSE_MONITORING: { publicFace: { fingerprints: ['nope'] } } }),
            ).toEqual(['ABUSE_MONITORING.publicFace.fingerprints.0']);
            expect(failedPaths({ ...bindings, ...devVars, ABUSE_MONITORING: { feeds: [] } })).toEqual([
                'ABUSE_MONITORING.feeds',
            ]);
            expect(failedPaths({ ...bindings, ...devVars, CERTSPOTTER_API_KEY: 'k' })).toEqual(['CERTSPOTTER_API_KEY']);
            expect(failedPaths({ ...bindings, ...devVars, WEB_RISK_API_KEY: `AIza${'x'.repeat(34)}` })).toEqual([
                'WEB_RISK_API_KEY',
            ]);
            expect(failedPaths({ ...bindings, ...devVars, WEB_RISK_API_KEY: `sk_${'x'.repeat(36)}` })).toEqual([
                'WEB_RISK_API_KEY',
            ]);
        });
    });
});
