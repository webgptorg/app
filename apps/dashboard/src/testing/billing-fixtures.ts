import { cryptoRandom } from '../adapters/crypto-random';
import { newOrgId, type OrgId } from '../domain/ids';

/**
 * Test-only billing values. Stripe keys and webhook secrets are generated per run, so no key-shaped string is ever
 * committed (AGENTS.md rule 8) and secret scanners have nothing to match.
 */

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomAlphanumeric(length: number): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => ALPHANUMERIC[byte % 62]).join('');
}

export function syntheticStripeKey(mode: 'test' | 'live' = 'test'): string {
    return ['sk', mode, randomAlphanumeric(32)].join('_');
}

export function syntheticWebhookSecret(): string {
    return `whsec_${randomAlphanumeric(32)}`;
}

export const TEST_PRICE_IDS = { starter: 'price_teststarter', scale: 'price_testscale' } as const;

/** A catalogue for tests only: real plans and prices are an open business decision (ADR 0017, D-07 brief). */
export const TEST_PLANS = {
    none: { features: [], quotas: { 'engines.max': 0, 'custom-domains.max': 0 } },
    plans: [
        {
            id: 'starter',
            stripeProductId: 'prod_teststarter',
            stripePriceId: TEST_PRICE_IDS.starter,
            features: ['engines.create'],
            quotas: { 'engines.max': 2, 'custom-domains.max': 0 },
        },
        {
            id: 'scale',
            stripeProductId: 'prod_testscale',
            stripePriceId: TEST_PRICE_IDS.scale,
            features: ['engines.create'],
            quotas: { 'engines.max': null, 'custom-domains.max': 5 },
        },
    ],
} as const;

export function testOrgId(): OrgId {
    return newOrgId(cryptoRandom);
}
