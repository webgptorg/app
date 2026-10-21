/**
 * Signs a synthetic webhook the way Stripe does (`t=<seconds>,v1=<hex HMAC-SHA-256 of "t.payload">`), written
 * independently of the stripe package so the tests check the adapter against the scheme, not against itself.
 */
export async function stripeSignatureHeader(payload: string, secret: string, timestampMs: number): Promise<string> {
    const timestamp = Math.floor(timestampMs / 1000);
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${String(timestamp)}.${payload}`));
    const hex = Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `t=${String(timestamp)},v1=${hex}`;
}

/** A Stripe-shaped event envelope; only what the adapter reads, plus a few fields it must ignore. */
export function stripeEvent(input: {
    readonly id: string;
    readonly type: string;
    readonly object: Readonly<Record<string, unknown>>;
}): string {
    return JSON.stringify({
        id: input.id,
        object: 'event',
        api_version: '2026-08-26.dahlia',
        created: 1_800_000_000,
        livemode: false,
        pending_webhooks: 1,
        request: { id: null, idempotency_key: null },
        type: input.type,
        data: { object: input.object },
    });
}
