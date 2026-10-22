// Flow 1: the mock engine's loader serves exactly the signed bundle under exactly the engine CSP, and refuses a
// tampered one while the verified bundle keeps being served.
import { ENGINE_UI_CSP } from '@ptbk/engine-api';
import type { Page } from '@playwright/test';

import { expect, need, test } from '../../src/ui-fixtures.ts';
import { required } from '../../src/ui-app.ts';
import { downloadUiRelease, sha256Hex } from '../../src/ui-release.ts';
import { UI_RELEASES } from '../../src/stack.ts';

/** SHA-256 of each path as the engine serves it to this page, fetched by the page itself. */
async function servedSha256(page: Page, paths: readonly string[]): Promise<Record<string, string>> {
    return page.evaluate(async (targets) => {
        const hex = (buffer: ArrayBuffer) =>
            Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
        const entries = await Promise.all(
            targets.map(async (path) => {
                const response = await fetch(`/${path}`, { cache: 'no-store' });
                if (!response.ok) return [path, `HTTP ${String(response.status)}`] as const;
                return [path, hex(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()))] as const;
            }),
        );
        return Object.fromEntries(entries);
    }, paths);
}

test('the engine serves the signed bundle, file for file, under exactly the engine CSP', async ({
    page,
    signIn,
    appUrl,
    caCertificatePem,
}) => {
    await signIn();
    const release = await downloadUiRelease(UI_RELEASES.installed, caCertificatePem);
    const response = await page.goto(appUrl('/'));
    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-security-policy']).toBe(ENGINE_UI_CSP);
    await expect(page.locator(`html[data-ui-version="${UI_RELEASES.installed}"]`)).toBeAttached();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const signed = Object.fromEntries(release.manifest.files.map((file) => [file.path, file.sha256]));
    for (const [path, bytes] of release.files) expect(sha256Hex(bytes), `${path} in the archive`).toBe(signed[path]);
    expect(
        sha256Hex(await required(response ?? undefined, 'document response').body()),
        'the document is the signed index.html',
    ).toBe(signed['index.html']);
    expect(await servedSha256(page, Object.keys(signed))).toEqual(signed);
});

test('a tampered release is refused and the verified bundle keeps being served', async ({
    page,
    engine,
    signIn,
    appUrl,
}) => {
    const tamperBundle = need(engine, 'tamperBundle');
    await signIn();
    await page.goto(appUrl('/'));
    await expect(page.locator(`html[data-ui-version="${UI_RELEASES.installed}"]`)).toBeAttached();
    const before = await servedSha256(page, ['index.html']);

    const outcome = await tamperBundle();
    expect(outcome).toEqual({ refused: true, reason: 'hash-mismatch', activeVersion: UI_RELEASES.installed });

    const reloaded = await page.reload();
    expect(reloaded?.headers()['content-security-policy']).toBe(ENGINE_UI_CSP);
    await expect(page.locator(`html[data-ui-version="${UI_RELEASES.installed}"]`)).toBeAttached();
    expect(await servedSha256(page, ['index.html'])).toEqual(before);

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Security' }).click();
    const bundle = page.getByRole('region', { name: 'UI bundle' });
    await expect(bundle.getByText('The engine refused a UI release')).toBeVisible();
    await expect(bundle.getByText('Reason: the download does not match its hash')).toBeVisible();
});
