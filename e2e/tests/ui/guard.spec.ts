// The page guard's positive controls: a test whose page breaks the CSP or leaves the engine's origin must fail. Each is
// expected to fail (`test.fail`), so this file passes only while the guard catches what it promises to catch.
import { expect, test } from '../../src/ui-fixtures.ts';

test.beforeEach(async ({ page, signIn, appUrl }) => {
    await signIn();
    await page.goto(appUrl('/agents'));
    await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible();
});

test('fails on an injected <style> element', async ({ page }) => {
    test.fail();
    await page.evaluate(() => {
        const style = document.createElement('style');
        style.textContent = 'body { color: red; }';
        document.head.append(style);
    });
});

test('fails on a stylesheet from another origin, such as a font @import', async ({ page }) => {
    test.fail();
    await page.evaluate(() => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://fonts.example.com/css?family=Inter';
        document.head.append(link);
    });
});

test('fails on a raw HTML sink, which Trusted Types refuses', async ({ page }) => {
    test.fail();
    await page.evaluate(() => {
        try {
            document.body.append(Object.assign(document.createElement('p'), { innerHTML: '<b>x</b>' }));
        } catch {
            // The refusal itself is what the guard reports.
        }
    });
});

test('fails on a native dialog', async ({ page }) => {
    test.fail();
    await page.evaluate(() => {
        window.alert('x');
    });
});
