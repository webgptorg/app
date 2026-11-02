// Flow 5: chat. A reply streams in, can be stopped mid-stream and renders as markdown once complete; a hostile reply
// stays inert: no request to the attacker, no dialog, no image, no script link.
import type { Page, Request } from '@playwright/test';

import { apiList, required, settled } from '../../src/ui-app.ts';
import { responsesContaining } from '../../src/response-recorder.ts';
import { expect, test } from '../../src/ui-fixtures.ts';

/** The `small-team` agent whose replies carry hostile markup (M-04). */
const HOSTILE_AGENT = 'Injection demo';
const ATTACKER = 'attacker.example';

interface Agent {
    readonly id: string;
    readonly name: string;
}

/** The hostile reply is on screen as text only: no image, no script, no script link, no request anywhere else. */
async function expectInert(page: Page): Promise<void> {
    await settled(page);
    const history = page.getByRole('region', { name: 'Messages' });
    await expect(history.getByText('Image: x').first()).toBeVisible();
    await expect(history.getByText('<script>alert(1)</script>', { exact: false }).first()).toBeVisible();
    await expect(history.getByText('<img src=https://attacker.example/i>', { exact: false }).first()).toBeVisible();
    await expect(history.locator('img, script, iframe, object, embed, [src], [srcset]')).toHaveCount(0);
    await expect(history.locator('a[href^="javascript:" i]')).toHaveCount(0);
    const hrefs = await history
        .locator('a[href]')
        .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
    expect(hrefs.filter((href) => href?.startsWith('https://') !== true)).toEqual([]);
}

async function startChat(page: Page, appUrl: (path: string) => string, agent: Agent, text: string): Promise<void> {
    await page.goto(appUrl(`/agents/${agent.id}/chat`));
    const starter = page.getByRole('textbox', { name: 'New chat' });
    await starter.fill(text);
    await starter.press('Enter');
    await expect(page.getByRole('region', { name: 'Messages' }).getByText(text, { exact: true })).toBeVisible();
}

test('streams a reply, stops another mid-stream and renders markdown once complete', async ({
    page,
    signIn,
    appUrl,
}) => {
    test.setTimeout(90_000);
    await signIn();
    await page.goto(appUrl('/'));
    const agent = required(
        (await apiList<Agent>(page, '/agents')).find((candidate) => candidate.name !== HOSTILE_AGENT),
        'agent',
    );
    await startChat(page, appUrl, agent, 'Explain the retry policy');
    const history = page.getByRole('region', { name: 'Messages' });

    await expect(history.getByText('Replying…')).toBeVisible();
    // While streaming, deltas are plain text; markdown is rendered only once the reply is complete.
    await expect(page.locator('[aria-live="polite"][aria-atomic="true"]')).toHaveText(
        new RegExp(`^${agent.name} replied`),
        { timeout: 60_000 },
    );
    await expect(history.getByText('Replying…')).toHaveCount(0);
    await expect(history.locator('pre code, ul, ol, table').first()).toBeVisible();

    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('And the rollback plan?');
    await composer.press('Enter');
    await expect(history.getByText('Replying…')).toBeVisible();
    // The agent's own Stop sits in the page header; this one stops the reply.
    await page.getByRole('tabpanel', { name: 'Chat' }).getByRole('button', { name: 'Stop' }).click();
    await expect(history.getByText('Stopped', { exact: true })).toBeVisible();
    await expect(history.getByText('Replying…')).toHaveCount(0);
});

test('a hostile reply makes no request, opens no dialog and renders no image or script link', async ({
    page,
    context,
    signIn,
    appUrl,
    engine,
    responses,
    guard,
}) => {
    test.setTimeout(90_000);
    const requests: Request[] = [];
    context.on('request', (request) => requests.push(request));
    await signIn();
    await page.goto(appUrl('/'));
    const hostile = required(
        (await apiList<Agent>(page, '/agents')).find((agent) => agent.name === HOSTILE_AGENT),
        `"${HOSTILE_AGENT}" agent`,
    );
    await startChat(page, appUrl, hostile, 'Show me the preview');
    await expect(page.locator('[aria-live="polite"][aria-atomic="true"]')).toHaveText(
        new RegExp(`^${HOSTILE_AGENT} replied`),
        { timeout: 60_000 },
    );
    // Twice: as the reply streamed in, and as the history renders it after a reload.
    await expectInert(page);
    await page.reload();
    await expectInert(page);

    expect(requests.filter((request) => request.url().includes(ATTACKER)).map((request) => request.url())).toEqual([]);
    expect(guard.foreignRequests).toEqual([]);
    expect(guard.dialogs).toEqual([]);

    // Positive controls: the request log saw the message go out and the reply stream come in, and the response
    // recorder read the hostile markup in the history the engine sent, so the empty lists above mean nothing happened,
    // not that nothing was seen.
    const engineRequests = requests
        .map((request) => new URL(request.url()))
        .filter((url) => url.host === engine.hostname);
    expect(engineRequests.some((url) => /^\/api\/v1\/chats\/[^/]+\/messages$/.test(url.pathname))).toBe(true);
    expect(engineRequests.some((url) => /\/messages\/[^/]+\/stream$/.test(url.pathname))).toBe(true);
    expect(responsesContaining(await responses.settled(), ATTACKER).length).toBeGreaterThan(0);
});
