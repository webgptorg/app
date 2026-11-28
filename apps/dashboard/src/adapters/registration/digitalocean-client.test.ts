import { expect, it, vi } from 'vitest';
import { digitalOceanClient } from './digitalocean-client';

it('persists a single public client and discards the losing simultaneous registration', async () => {
    let retained: string | null = null,
        n = 0;
    const send = vi.fn<typeof fetch>((input, opts) => {
        if (opts?.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
        expect(input).toBe('https://cloud.digitalocean.com/v1/oauth/register');
        expect(opts?.body).toContain('https://app.example.test/vps/return');
        return Promise.resolve(
            Response.json({ client_id: 'client' + String(++n), registration_access_token: crypto.randomUUID() }),
        );
    });
    const get = digitalOceanClient(
        send,
        { get: () => Promise.resolve(retained), retain: (_callback, id) => Promise.resolve((retained ??= id)) },
        'https://app.example.test/vps/return',
    );
    const signal = new AbortController().signal;
    expect(await Promise.all([get(signal), get(signal)])).toEqual(['client1', 'client1']);
    expect(await get(signal)).toBe('client1');
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2]?.[0]).toBe('https://cloud.digitalocean.com/v1/oauth/register/client2');
});
