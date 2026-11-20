import { expect, expectNoBrowserErrors, test } from './fixtures';

test('the public abuse page, signed out, in English and Czech, under the production CSP (I-05)', async ({
    page,
    browserReport,
    checkScreen,
}) => {
    await page.goto('/abuse');
    await expect(page.getByRole('heading', { name: 'Report abuse', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'abuse@ptbk.test' })).toHaveAttribute('href', 'mailto:abuse@ptbk.test');
    await checkScreen('abuse');

    await page.context().addCookies([{ name: 'ptbk_locale', value: 'cs', url: page.url() }]);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Nahlásit zneužití', level: 1 })).toBeVisible();

    const securityTxt = await page.request.get('/.well-known/security.txt');
    expect(securityTxt.headers()['content-type']).toBe('text/plain; charset=utf-8');
    expect(await securityTxt.text()).toContain('Contact: mailto:abuse@ptbk.test');
    expectNoBrowserErrors(browserReport());
});

test('the public trust page, signed out, reached from the sign-in footer', async ({
    page,
    browserReport,
    checkScreen,
}) => {
    await page.goto('/signin');
    await page
        .getByRole('navigation', { name: 'About Promptbook' })
        .getByRole('link', { name: 'How Promptbook protects you' })
        .click();
    await expect(page.getByRole('heading', { name: 'How Promptbook protects you', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Our relay', level: 3 })).toBeVisible();
    await checkScreen('trust');

    // The drawings take their colours from theme tokens, so contrast is checked in the dark theme too.
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await checkScreen('trust, dark');

    await page.context().addCookies([{ name: 'ptbk_locale', value: 'cs', url: page.url() }]);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Jak Vás Promptbook chrání', level: 1 })).toBeVisible();
    await checkScreen('trust, Czech');
    expectNoBrowserErrors(browserReport());
});
