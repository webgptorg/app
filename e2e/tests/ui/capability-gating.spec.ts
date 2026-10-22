// Flow 17: an engine that does not offer triggers: no nav item, no agent tab, the route explains the feature is not
// available, and the API answers 404 capability-not-supported.
import { apiCall, apiList, required } from '../../src/ui-app.ts';
import { ALL_CAPABILITIES } from '../../src/engine-target.ts';
import { UI_SCENARIO, UI_SEED, expect, need, test } from '../../src/ui-fixtures.ts';

test('without the triggers capability the UI offers no triggers and the API refuses them', async ({
    page,
    engine,
    signIn,
    appUrl,
}) => {
    const reset = need(engine, 'reset');
    await reset({
        scenario: UI_SCENARIO,
        seed: UI_SEED,
        capabilities: ALL_CAPABILITIES.filter((capability) => capability !== 'triggers'),
    });
    await signIn();
    await page.goto(appUrl('/'));
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Runs', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Triggers', exact: true })).toHaveCount(0);

    const agent = required((await apiList<{ id: string; name: string }>(page, '/agents'))[0], 'agent');
    await page.goto(appUrl(`/agents/${agent.id}`));
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Runs' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Triggers' })).toHaveCount(0);

    await page.goto(appUrl('/triggers'));
    await expect(page.getByRole('heading', { name: 'Not available on this engine' })).toBeVisible();
    const answer = await apiCall<{ code?: string }>(page, 'GET', '/triggers');
    expect(answer.status).toBe(404);
    expect(answer.body.code).toBe('capability-not-supported');
});
