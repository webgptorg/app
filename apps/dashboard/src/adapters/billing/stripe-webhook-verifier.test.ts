import { describe, expect, it } from 'vitest';

import { syntheticWebhookSecret } from '../../testing/billing-fixtures';
import { stripeEvent, stripeSignatureHeader } from '../../testing/stripe-signature';
import { createFakeClock } from '../fake-clock';
import { createStripeWebhookVerifier, rejectAllWebhooks, WEBHOOK_TOLERANCE_SECONDS } from './stripe-webhook-verifier';

const NOW = 1_800_000_000_000;
const secret = syntheticWebhookSecret();
const encode = (text: string) => new TextEncoder().encode(text);

async function verify(payload: string, options: { readonly signedAt?: number; readonly secret?: string } = {}) {
    const clock = createFakeClock(NOW);
    const signature = await stripeSignatureHeader(payload, options.secret ?? secret, options.signedAt ?? NOW);
    return createStripeWebhookVerifier({ secret, clock })(encode(payload), signature);
}

const subscriptionUpdated = stripeEvent({
    id: 'evt_1',
    type: 'customer.subscription.updated',
    object: { id: 'sub_123', object: 'subscription', status: 'active', customer: 'cus_1' },
});

describe('Stripe webhook verification', () => {
    it('accepts a correctly signed event and keeps only its ID, type and subscription', async () => {
        expect(await verify(subscriptionUpdated)).toEqual({
            kind: 'verified',
            event: { id: 'evt_1', type: 'customer.subscription.updated', subscriptionId: 'sub_123' },
        });
    });

    it.each([
        ['checkout.session.completed', { object: 'checkout.session', subscription: 'sub_co' }, 'sub_co'],
        ['checkout.session.completed', { subscription: { id: 'sub_expanded' } }, 'sub_expanded'],
        ['checkout.session.completed', { mode: 'payment', subscription: null }, null],
        ['invoice.paid', { parent: { subscription_details: { subscription: 'sub_parent' } } }, 'sub_parent'],
        ['invoice.payment_failed', { parent: null, subscription: 'sub_legacy' }, 'sub_legacy'],
        ['invoice.paid', { parent: { subscription_details: null } }, null],
        ['customer.subscription.deleted', { id: 'sub_deleted', status: 'canceled' }, 'sub_deleted'],
        ['balance.available', { object: 'balance' }, null],
    ])('reads the subscription of %s', async (type, object, subscriptionId) => {
        const verified = await verify(stripeEvent({ id: 'evt_2', type, object }));
        expect(verified).toEqual({ kind: 'verified', event: { id: 'evt_2', type, subscriptionId } });
    });

    it('rejects a signature made with another secret', async () => {
        expect(await verify(subscriptionUpdated, { secret: syntheticWebhookSecret() })).toEqual({ kind: 'invalid' });
    });

    it('rejects a body changed after signing, even by one byte', async () => {
        const signature = await stripeSignatureHeader(subscriptionUpdated, secret, NOW);
        const verifier = createStripeWebhookVerifier({ secret, clock: createFakeClock(NOW) });
        expect(await verifier(encode(`${subscriptionUpdated} `), signature)).toEqual({ kind: 'invalid' });
        expect(await verifier(encode(subscriptionUpdated.replace('sub_123', 'sub_124')), signature)).toEqual({
            kind: 'invalid',
        });
    });

    it('rejects a timestamp older than five minutes and accepts one exactly at the limit', async () => {
        const limit = NOW - WEBHOOK_TOLERANCE_SECONDS * 1000;
        expect(await verify(subscriptionUpdated, { signedAt: limit - 1000 })).toEqual({ kind: 'invalid' });
        expect((await verify(subscriptionUpdated, { signedAt: limit })).kind).toBe('verified');
    });

    it('rejects malformed signature headers', async () => {
        const verifier = createStripeWebhookVerifier({ secret, clock: createFakeClock(NOW) });
        for (const header of ['', 'garbage', `t=${String(NOW / 1000)}`, 'v1=00']) {
            expect(await verifier(encode(subscriptionUpdated), header)).toEqual({ kind: 'invalid' });
        }
    });

    it('rejects a signed body that is not a readable event', async () => {
        for (const payload of [
            'not json',
            JSON.stringify({ id: 'evt_1', type: 'invoice.paid' }),
            stripeEvent({ id: 'not-an-event-id', type: 'invoice.paid', object: {} }),
            stripeEvent({ id: 'evt_3', type: 'customer.subscription.updated', object: { id: 42 } }),
            stripeEvent({ id: 'evt_4', type: 'invoice.paid', object: { subscription: 'sub with spaces' } }),
        ]) {
            expect(await verify(payload), payload).toEqual({ kind: 'invalid' });
        }
    });

    it('refuses everything without a secret', async () => {
        expect(await rejectAllWebhooks()).toEqual({ kind: 'invalid' });
    });
});
