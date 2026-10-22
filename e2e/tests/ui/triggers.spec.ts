// Flow 15: triggers. A cron schedule created in the UI fires when engine time passes its next fire, linked to the run it
// started; paused it does not fire, resumed it does again; an email to an email trigger starts an email run.
import type { Page } from '@playwright/test';

import { apiGet, apiList, required, uniqueName } from '../../src/ui-app.ts';
import { expect, need, test } from '../../src/ui-fixtures.ts';

/** Past the next fire of an every-15-minutes schedule, wherever engine time stands. */
const PAST_NEXT_FIRE_MS = 16 * 60 * 1000;

interface Trigger {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly lifecycle: string;
}

interface Fire {
    readonly outcome: string;
    readonly runId: string | null;
}

async function fires(page: Page, triggerId: string): Promise<readonly Fire[]> {
    return apiList<Fire>(page, `/triggers/${triggerId}/fires`);
}

test('a cron schedule fires as engine time passes, links its run, and pauses and resumes', async ({
    page,
    engine,
    signIn,
    appUrl,
}) => {
    test.setTimeout(90_000);
    const advanceTime = need(engine, 'advanceTime');
    const name = uniqueName('Digest');
    await signIn();
    await page.goto(appUrl('/triggers/new'));
    const agent = required((await apiList<{ id: string }>(page, '/agents'))[0], 'agent');
    await page.getByLabel(/^Kind/).selectOption('schedule');
    await page.getByLabel(/^Agent/).selectOption(agent.id);
    await page.getByLabel(/^Name/).fill(name);
    await page.getByLabel(/^Repeats/).selectOption('cron');
    await page.getByLabel(/^Cron expression/).fill('*/15 * * * *');
    await page.getByLabel(/^Time zone/).selectOption('UTC');
    await page.getByLabel(/^Message/).fill('Send the digest.');
    await page.getByRole('button', { name: 'Create trigger' }).click();
    await expect(page.getByText(`${name} was created.`)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    const triggerId = required(/\/triggers\/([^/?#]+)$/.exec(page.url())?.[1], 'trigger ID');

    const history = page.getByRole('table', { name: 'Fire history' });
    await advanceTime(PAST_NEXT_FIRE_MS);
    await expect(history.getByRole('link', { name: 'Open run' }).first()).toBeVisible();
    const fired = (await fires(page, triggerId)).length;
    expect(fired).toBeGreaterThan(0);
    const firstRun = required((await fires(page, triggerId))[0]?.runId ?? undefined, 'run of the fire');
    await expect(history.getByRole('link', { name: 'Open run' }).first()).toHaveAttribute('href', `/runs/${firstRun}`);

    await page.getByRole('button', { name: `Pause ${name}` }).click();
    await expect(page.getByText(`${name} is paused.`)).toBeVisible();
    await advanceTime(PAST_NEXT_FIRE_MS);
    expect(await fires(page, triggerId)).toHaveLength(fired);

    await page.getByRole('button', { name: `Resume ${name}` }).click();
    await expect(page.getByText(`${name} is running again.`)).toBeVisible();
    await advanceTime(PAST_NEXT_FIRE_MS);
    await expect.poll(async () => (await fires(page, triggerId)).length).toBeGreaterThan(fired);

    await history.getByRole('link', { name: 'Open run' }).first().click();
    await expect(page).toHaveURL(/\/runs\/[^/]+$/);
    const opened = required(/\/runs\/([^/?#]+)$/.exec(page.url())?.[1], 'run ID');
    expect((await apiGet<{ triggerId: string | null }>(page, `/runs/${opened}`)).triggerId).toBe(triggerId);
});

test('an email to an email trigger starts an email run in the timeline', async ({ page, engine, signIn, appUrl }) => {
    const inboundEmail = need(engine, 'inboundEmail');
    const subject = uniqueName('Invoice question');
    await signIn();
    await page.goto(appUrl('/runs?source=email'));
    const trigger = required(
        (await apiList<Trigger>(page, '/triggers?kind=email')).find((candidate) => candidate.lifecycle === 'active'),
        'active email trigger',
    );
    const { runId } = await inboundEmail({ triggerId: trigger.id, from: 'customer@example.com', subject });
    const run = await apiGet<{ source: string; preview: string | null }>(
        page,
        `/runs/${required(runId ?? undefined, 'run')}`,
    );
    expect(run.source).toBe('email');

    const row = page.getByRole('row').filter({ has: page.locator(`a[href="/runs/${runId ?? ''}"]`) });
    await expect(row).toBeVisible();
    await expect(row).toContainText(subject);
    await expect(row).toContainText('Email');
});
