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
