import type { Page } from '@playwright/test';

import { expect, test } from '../../src/fixtures.ts';
import { MOCK_ENGINE_CONTROL, UI_RELEASES } from '../../src/stack.ts';

// ENGINE_UI_CSP from @ptbk/engine-api, which the e2e image does not install. The mock engine sends the constant
// itself, so a change there fails here until this copy follows: the header is checked byte for byte.
const ENGINE_UI_CSP =
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types ptbk-html";

const CONTROL = `http://${MOCK_ENGINE_CONTROL.ip}:${String(MOCK_ENGINE_CONTROL.port)}`;
const INSTALL_DEADLINE_MS = 60_000;

interface UiStatus {
    readonly active: { readonly version: string; readonly sha256: string } | null;
    readonly lastOutcome: unknown;
}

async function control(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${CONTROL}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    expect(response.ok, `${path} answered ${String(response.status)}`).toBe(true);
    return response.json();
}

/** The loader checks once at startup; wait for that check to have installed the pinned release. */
async function installedUi(): Promise<UiStatus> {
    await expect
        .poll(async () => ((await control('/__mock/ui')) as UiStatus).active?.version, { timeout: INSTALL_DEADLINE_MS })
        .toBe(UI_RELEASES.installed);
    return (await control('/__mock/ui')) as UiStatus;
}

/** Console messages and page errors a CSP or Trusted Types refusal produces, beside the violation events. */
function policyMessages(page: Page): string[] {
    const messages: string[] = [];
    page.on('console', (message) => {
        if (/content security policy|trusted type/i.test(message.text())) messages.push(message.text());
    });
    page.on('pageerror', (error) => messages.push(`pageerror: ${error.message}`));
    return messages;
}

test('the mock engine serves its verified UI release under the engine CSP and refuses a tampered one', async ({
    page,
    engineUrl,
    requestLog,
    cspViolations,
}) => {
    test.setTimeout(INSTALL_DEADLINE_MS + 60_000);
    const status = await installedUi();
    expect(status.active?.version, JSON.stringify(status.lastOutcome)).toBe(UI_RELEASES.installed);

    const session = (await control('/__mock/sessions', { subject: { kind: 'owner' } })) as {
        cookie: { name: string; value: string };
    };
    await page
        .context()
        .addCookies([{ ...session.cookie, url: engineUrl, secure: true, httpOnly: true, sameSite: 'Strict' }]);
    const messages = policyMessages(page);

    const response = await page.goto(engineUrl);
    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-security-policy']).toBe(ENGINE_UI_CSP);
    // Set by the bundle's own script, so this also proves the app ran.
    await expect(page.locator(`html[data-ui-version="${UI_RELEASES.installed}"]`)).toBeAttached();
    await expect(page.locator('main')).toBeVisible();

    const published = (await control('/__mock/ui/check', { pinnedVersion: UI_RELEASES.tampered })) as {
        outcome: unknown;
        active: { version: string } | null;
    };
    expect(published.outcome).toEqual({ kind: 'refused', version: UI_RELEASES.tampered, reason: 'hash-mismatch' });
    expect(published.active?.version).toBe(UI_RELEASES.installed);

    const reloaded = await page.reload();
    expect(reloaded?.status()).toBe(200);
    await expect(page.locator(`html[data-ui-version="${UI_RELEASES.installed}"]`)).toBeAttached();
    await expect(page.locator('main')).toBeVisible();

    const origin = new URL(engineUrl).origin;
    expect(requestLog.filter((url) => new URL(url).origin !== origin)).toEqual([]);
    expect(cspViolations).toEqual([]);
    expect(messages).toEqual([]);
});

test('an anonymous visitor gets only the sign-in page, never the bundle', async ({ page, engineUrl }) => {
    const response = await page.goto(engineUrl);
    expect(new URL(page.url()).pathname).toBe('/auth/sign-in');
    expect(response?.headers()['content-security-policy']).toBe(ENGINE_UI_CSP);
    await expect(page.locator(`html[data-ui-version]`)).toHaveCount(0);
});
