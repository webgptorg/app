import { expect, it } from 'vitest';
import { exchangeWebsiteTicket } from './website-handoff-client';
const code = 'a'.repeat(43);
it('requires a complete challenge and a verified server identity', async () => {
    const input = {
        websiteOrigin: 'https://www.ptbk.io',
        code,
        challenge: code,
        secret: 'server-only',
        signal: new AbortController().signal,
        fetch: () =>
            Promise.resolve(
                Response.json({
                    version: 1,
                    subject: '4408b4d6-6005-4b77-97eb-fdd67847ee92',
                    email: 'owner@example.test',
                    emailVerified: false,
                }),
            ),
    };
    expect(await exchangeWebsiteTicket(input)).toBeNull();
    expect(await exchangeWebsiteTicket({ ...input, challenge: '' })).toBeNull();
});
it('accepts a verified identity, tolerates response extensions and rejects failed exchanges', async () => {
    const identity = {
        subject: '4408b4d6-6005-4b77-97eb-fdd67847ee92',
        email: 'owner@example.test',
        emailVerified: true as const,
    };
    const input = {
        websiteOrigin: 'https://www.ptbk.io',
        code,
        challenge: code,
        secret: 'server-only',
        signal: new AbortController().signal,
        fetch: () => Promise.resolve(Response.json({ version: 1, ...identity, future: true })),
    };
    expect(await exchangeWebsiteTicket(input)).toEqual(identity);
    expect(
        await exchangeWebsiteTicket({ ...input, fetch: () => Promise.resolve(new Response(null, { status: 403 })) }),
    ).toBeNull();
    expect(await exchangeWebsiteTicket({ ...input, fetch: () => Promise.reject(new Error('unavailable')) })).toBeNull();
});
it('exchanges at the configured website only', async () => {
    let requested = '';
    await exchangeWebsiteTicket({
        websiteOrigin: 'https://staging.ptbk.io',
        code,
        challenge: code,
        secret: 'server-only',
        signal: new AbortController().signal,
        fetch: (url) => {
            requested = url instanceof Request ? url.url : url.toString();
            return Promise.resolve(new Response(null, { status: 410 }));
        },
    });
    expect(requested).toBe('https://staging.ptbk.io/api/promptbook-billing/app/exchange');
});
