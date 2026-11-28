import { expect, test } from '@playwright/test';
import { engineView, INSTALL_GUIDE_URL, linkCodeView, session } from '../../src/client/testing/fixtures.ts';

for (const outcome of ['created', 'declined'] as const) {
    test(`DigitalOcean consent, purchase confirmation and browser handoff (${outcome})`, async ({ page, baseURL }) => {
        const issued = linkCodeView({ expiresAt: Date.now() + 3600_000, vpsProviders: [{ provider: 'digitalocean' }] });
        const engine = engineView({ status: 'owner-pending', reachableRelays: 1 });
        const linkPath = '/api/engines/link-codes/' + issued.linkCodeId;
        let submissions = 0;
        await page.route('**/api/**', async (route) => {
            const path = new URL(route.request().url()).pathname;
            if (path === '/api/session') {
                await route.fulfill({
                    json: session({ billingEnabled: false, permissions: ['org.read', 'engine.read', 'engine.link'] }),
                });
                return;
            }
            if (path === '/api/engines/link-eligibility') {
                await route.fulfill({
                    json: { eligibility: 'allowed', installGuideUrl: INSTALL_GUIDE_URL, linkCodeTtlS: 3600 },
                });
                return;
            }
            if (path === '/api/engines/link-codes' && route.request().method() === 'POST') {
                await route.fulfill({ json: issued });
                return;
            }
            if (path === linkPath + '/vps/authorize') {
                await route.fulfill({ json: { clientId: 'public-client' } });
                return;
            }
            if (path === linkPath + '/vps' && route.request().method() === 'POST') {
                expect(route.request().postDataJSON()).toMatchObject({
                    monthlyUsd: 24,
                    code: 'browser-fixture',
                    provider: 'digitalocean',
                });
                submissions++;
                if (outcome === 'declined') {
                    await route.fulfill({
                        status: 409,
                        contentType: 'application/problem+json',
                        json: { type: 'about:blank', title: 'Conflict', status: 409, code: 'provider-rejected' },
                    });
                } else {
                    await route.fulfill({ json: { submitted: true } });
                }
                return;
            }
            if (path === linkPath) {
                await route.fulfill({
                    json: submissions
                        ? { status: 'linked', hostname: engine.hostname, engineId: engine.engineId }
                        : { status: 'pending', expiresAt: issued.expiresAt },
                });
                return;
            }
            if (path === '/api/engines/' + engine.engineId) {
                await route.fulfill({ json: { engine } });
                return;
            }
            await route.continue();
        });
        await page.route('https://cloud.digitalocean.com/v1/oauth/authorize?**', async (route) => {
            const url = new URL(route.request().url());
            expect(url.searchParams.get('code_challenge_method')).toBe('S256');
            const callback = new URL('/vps/return', baseURL);
            callback.searchParams.set('code', 'browser-fixture');
            callback.searchParams.set('state', url.searchParams.get('state') ?? '');
            await route.fulfill({ status: 302, headers: { location: callback.href } });
        });
        await page.goto('/engines/new');
        await page.getByRole('button', { name: 'Launch on DigitalOcean' }).click();
        const confirm = page.getByRole('button', { name: /Create Droplet.*24/ });
        await expect(confirm).toBeVisible();
        expect(submissions).toBe(0);
        await page.reload();
        await confirm.click();
        if (outcome === 'declined') {
            await expect(page.getByRole('link', { name: 'Open DigitalOcean billing' })).toHaveAttribute(
                'href',
                'https://cloud.digitalocean.com/account/billing',
            );
            await expect(page.getByRole('button', { name: 'Return to launch' })).toBeVisible();
            expect(submissions).toBe(1);
            return;
        }
        await expect(page.locator('a[href="https://' + engine.hostname + '/"]')).toBeVisible();
        await page.reload();
        await expect(page.locator('a[href="https://' + engine.hostname + '/"]')).toBeVisible();
        expect(submissions).toBe(1);
    });
}
