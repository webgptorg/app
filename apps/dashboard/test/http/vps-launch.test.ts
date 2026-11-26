import { describe, expect, it, vi } from 'vitest';
import { digitalOceanProvider } from '../../src/adapters/registration/digitalocean';
import { signUp } from '../../src/testing/auth-flows';
import { createAuthHarness } from '../../src/testing/auth-harness';
import { createMemoryAuthStore } from '../../src/testing/memory-auth-store';
import { TEST_ENGINE_INSTALLATION } from '../../src/testing/install-fixtures';
import type { LinkCodeView } from '../../src/shared/api/routes';
import { DIGITALOCEAN } from '../../src/shared/vps';

async function fixture(scenario: 'ok' | 'price' | 'rejected' | 'unknown' | 'old') {
    const token = crypto.randomUUID(),
        user = crypto.randomUUID(),
        team = crypto.randomUUID();
    const creations: { name: string; user_data: string; region: string; size: string }[] = [];
    const send = vi.fn<typeof fetch>(async (input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.endsWith('/token'))
            return Response.json({ access_token: token, info: { uuid: user, team_uuid: team } });
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + token);
        if (url.includes('/sizes?'))
            return Response.json({
                sizes: [
                    {
                        slug: DIGITALOCEAN.size,
                        price_monthly: scenario === 'price' ? 48 : 24,
                        price_hourly: 0.03571,
                        regions: ['fra1'],
                        available: true,
                    },
                ],
            });
        if (url.endsWith('/revoke')) return Response.json({});
        expect(url).toBe('https://api.digitalocean.com/v2/droplets');
        if (typeof init?.body !== 'string') throw new Error('Expected JSON');
        const body = JSON.parse(await new Response(init.body).text()) as (typeof creations)[number];
        creations.push(body);
        expect(body.user_data).not.toContain(token);
        expect(body.user_data).not.toContain('--setup-link');
        expect(body.user_data).not.toContain('__LINK__');
        expect(body.user_data).toContain('sha256sum --check');
        if (scenario === 'unknown') throw new TypeError('Disconnected');
        if (scenario === 'rejected') return new Response(null, { status: 422 });
        return Response.json({ droplet: { id: 123 } }, { status: 202 });
    });
    const provider = digitalOceanProvider(send, 'https://app.ptbk.test', () => Promise.resolve('public-client'));
    const harness = createAuthHarness({
        store: createMemoryAuthStore(),
        billing: 'off',
        engineInstallation: {
            ...TEST_ENGINE_INSTALLATION,
            ...(scenario === 'old' ? {} : { digitalOceanOwner: true as const }),
        },
        vpsProviders: { digitalocean: provider },
    });
    const browser = harness.browser();
    await signUp(harness, browser);
    const view = (await browser.request('POST', '/api/engines/link-codes')).body as LinkCodeView;
    const path = '/api/engines/link-codes/' + view.linkCodeId + '/vps';
    const submit = () =>
        browser.request('POST', path, {
            code: 'fixture-code',
            verifier: 'a'.repeat(43),
            provider: 'digitalocean',
            monthlyUsd: 24,
        });
    return { browser, path, submit, creations, view };
}

describe('DigitalOcean launch', () => {
    it('authorizes without spending, then creates once, even across concurrent confirmations', async () => {
        const f = await fixture('ok');
        expect(f.view.vpsProviders).toEqual([{ provider: 'digitalocean' }]);
        expect((await f.browser.request('POST', f.path + '/authorize', { provider: 'digitalocean' })).body).toEqual({
            clientId: 'public-client',
        });
        expect(f.creations).toHaveLength(0);
        const results = await Promise.all([f.submit(), f.submit()]);
        expect(results.map((r) => r.status)).toEqual([200, 200]);
        expect(f.creations).toHaveLength(1);
        expect(f.creations[0]?.user_data).not.toContain(f.view.linkCode);
        expect((await f.browser.request('GET', f.path)).body).toMatchObject({
            reservation: { provider: 'digitalocean', resourceId: '123' },
        });
    });
    it('retains the reservation when a create response is lost', async () => {
        const f = await fixture('unknown');
        await f.submit();
        await f.submit();
        expect(f.creations).toHaveLength(1);
        expect((await f.browser.request('GET', f.path)).body).toMatchObject({ reservation: { resourceId: null } });
    });
    it.each(['price', 'old'] as const)(
        'does not submit when the price or engine capability is unsuitable (%s)',
        async (scenario) => {
            const f = await fixture(scenario);
            expect((await f.submit()).status).toBe(409);
            expect(f.creations).toHaveLength(0);
            if (scenario === 'old') expect(f.view.vpsProviders).toBeUndefined();
        },
    );
    it('allows a new attempt after a definitive refusal', async () => {
        const f = await fixture('rejected');
        expect((await f.submit()).status).toBe(409);
        expect((await f.browser.request('GET', f.path)).body).toMatchObject({ reservation: null });
    });
});
