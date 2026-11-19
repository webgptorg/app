import { expect, expectCleanPage, test } from './fixtures.ts';
import { HOSTILE_SETUP_TEXT, routeSetupScript, SETUP_SCRIPT } from './onboarding-script.ts';

const SECRET = 'sk-test-csp-0123456789';

test.describe('setup in the browser on a paired engine under the engine CSP', () => {
    SETUP_SCRIPT.forEach((_, step) => {
        test(`step ${String(step)} renders cleanly, with setup as the only page`, async ({ page, visit }) => {
            await routeSetupScript(page, SETUP_SCRIPT, step);
            const report = await visit('/');
            await expect(page).toHaveURL(/\/onboarding$/);
            await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
            await expect(page.getByRole('navigation')).toHaveCount(0);
            await expect(page.getByText(/Your answers are saved/)).toBeVisible();
            expectCleanPage(report);
        });
    });

    test('answers through an alternative, a refused secret and the review, keeping engine text inert', async ({
        page,
        visit,
    }) => {
        const bodies = await routeSetupScript(page, SETUP_SCRIPT, 1);
        const report = await visit('/files');
        await expect(page).toHaveURL(/\/onboarding$/);
        await expect(page.getByRole('list', { name: 'What the engine is doing' })).toContainText('command not found');
        const terminal = page.getByRole('link', { name: /Sign in in a terminal instead/ });
        await expect(terminal).toHaveAttribute('href', '/_ptbk/harness-terminal?harness=codex');
        await expect(terminal).toHaveAttribute('target', '_blank');
        await expect(terminal).toHaveAttribute('rel', 'noopener');

        await page.getByRole('button', { name: 'Use an API key instead' }).click();
        const key = page.getByRole('textbox', { name: 'OpenAI API key' });
        await key.fill(SECRET);
        await key.press('Enter');
        await expect(page.getByText('OpenAI did not accept this key.', { exact: false })).toBeVisible();
        await expect(page.getByRole('textbox', { name: 'OpenAI API key' })).toHaveValue('');
        expect(await page.content()).not.toContain(SECRET);

        await page.getByRole('textbox', { name: 'OpenAI API key' }).fill(SECRET);
        await page.getByRole('button', { name: 'Continue' }).click();
        await expect(page.getByRole('heading', { level: 1, name: 'Review' })).toBeVisible();
        await expect(page.getByRole('definition').first()).toHaveText(HOSTILE_SETUP_TEXT);
        await expect(page.locator('main img, main script')).toHaveCount(0);
        await page.getByRole('button', { name: 'Create and start' }).click();
        await expect(page.getByText('ptbk onboarding')).toBeVisible();

        expect(bodies).toEqual([
            { promptId: 'login-codex', action: 'alternative', alternativeId: 'api-key' },
            { promptId: 'key-1', action: 'answer', answer: { kind: 'secret', value: SECRET } },
            { promptId: 'key-2', action: 'answer', answer: { kind: 'secret', value: SECRET } },
            { promptId: 'review', action: 'answer', answer: { kind: 'confirm', confirmed: true } },
        ]);
        expect(report.pageErrors).toEqual([]);
        expect(await page.evaluate(() => window.__ptbkCspViolations ?? [])).toEqual([]);
    });
});
