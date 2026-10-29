// U-14: the book editor's live test chat answers from the unsaved draft, and saves nothing.
import { apiGet, apiList, required } from '../../src/ui-app.ts';
import { expect, test } from '../../src/ui-fixtures.ts';

/** The `small-team` agent whose replies carry hostile markup; any other agent will do here. */
const HOSTILE_AGENT = 'Injection demo';
const DRAFT_NAME = 'Draft Tester';

interface Agent {
    readonly id: string;
    readonly name: string;
}

test('tests the unsaved book in the test chat without saving it', async ({ page, signIn, appUrl }) => {
    test.setTimeout(60_000);
    await signIn();
    await page.goto(appUrl('/'));
    const agents = await apiList<Agent>(page, '/agents');
    const agent = required(
        agents.find(({ name }) => name !== HOSTILE_AGENT),
        'an agent',
    );
    const before = await apiGet<{ readonly source: string; readonly revisionId: string }>(
        page,
        `/agents/${agent.id}/source`,
    );
    await page.goto(appUrl(`/agents/${agent.id}/book`));
    const editor = page.getByTestId('book-editor');
    await expect(editor.locator('.tok-heading').first()).toBeVisible();

    // The first line names the agent: rename it in the draft only.
    await page.getByRole('textbox', { name: 'Book source' }).click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('Shift+End');
    await page.keyboard.type(DRAFT_NAME);
    await expect(page.getByText('Unsaved changes')).toBeVisible();

    const panel = page.getByTestId('book-test-chat');
    await expect(panel.getByText('Test · not saved')).toBeVisible();
    const composer = panel.getByRole('textbox', { name: 'Message' });
    await composer.fill('What would you do first?');
    await composer.press('Enter');
    const history = panel.getByRole('region', { name: 'Test messages' });
    await expect(history.getByText('What would you do first?')).toBeVisible();
    await expect(panel.locator('[aria-live="polite"][aria-atomic="true"]')).toHaveText(`${DRAFT_NAME} replied`, {
        timeout: 30_000,
    });
    await expect(history.getByText(`${DRAFT_NAME} has a few notes`, { exact: false })).toBeVisible();

    await panel.getByRole('button', { name: 'Reset' }).click();
    await expect(panel.getByText('These messages are not kept', { exact: false })).toBeVisible();

    const after = await apiGet<{ readonly source: string; readonly revisionId: string }>(
        page,
        `/agents/${agent.id}/source`,
    );
    expect(after).toEqual(before);
    expect(after.source.split('\n')[0]).not.toBe(DRAFT_NAME);
});
