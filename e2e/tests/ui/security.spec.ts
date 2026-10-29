// Flow 6: the security panel shows what the owner can check independently: the engine version, both relays
// connected, the hostnames, the certificate the browser actually received, the heartbeat the engine sent and the hash of
// the signed UI archive under test.
import type { Page } from '@playwright/test';

import { apiGet, factValue, shownSha256 } from '../../src/ui-app.ts';
import { downloadUiRelease } from '../../src/ui-release.ts';
import { UI_RELEASES } from '../../src/stack.ts';
import { expect, need, test } from '../../src/ui-fixtures.ts';

interface SecurityOverview {
    readonly engine: { readonly version: string };
}

/** A row of the security checklist, opened: its details are collapsed while the engine reports nothing wrong. */
async function openCheck(page: Page, name: string) {
    const region = page.getByRole('region', { name, exact: true });
    if (!(await region.locator('details').evaluate((details) => (details as HTMLDetailsElement).open))) {
        await region.locator('summary').click();
    }
    return region;
}

test('the security panel matches what the browser and the release store see', async ({
    page,
    engine,
    signIn,
    appUrl,
    relayHosts,
    engineHost,
    engineCertSha256,
    peerCertificateSha256,
    caCertificatePem,
}) => {
    const lastHeartbeat = need(engine, 'lastHeartbeat');
    await signIn();
    await page.goto(appUrl('/security'));
    await expect(page.getByRole('heading', { name: /your data stays on your server/ })).toBeVisible();

    const reported = await apiGet<SecurityOverview>(page, '/security');
    const engineCard = await openCheck(page, 'Engine');
    await expect(factValue(engineCard, 'Version')).toHaveText(reported.engine.version);
    expect(reported.engine.version).toMatch(/^\d+\.\d+\.\d+/);

    const relays = await openCheck(page, 'Relays and tunnel');
    for (const relay of relayHosts) {
        await expect(relays.getByRole('listitem').filter({ hasText: relay.hostname })).toContainText('Connected');
    }
    await expect(await openCheck(page, 'Hostnames')).toContainText(engineHost);

    const browserSha256 = await peerCertificateSha256(page);
    expect(browserSha256).toBe(engineCertSha256);
    const certificate = await openCheck(page, 'Certificate and Certificate Transparency');
    await expect.poll(() => shownSha256(factValue(certificate, 'Certificate SHA-256'))).toBe(browserSha256);

    const heartbeat = await openCheck(page, 'Last heartbeat');
    const sent = await lastHeartbeat();
    if (sent === null) {
        // This stack has no dashboard, so the engine has sent none; the panel must say so rather than invent one.
        await expect(heartbeat.getByText('No heartbeat sent yet')).toBeVisible();
        await expect(page.getByTestId('heartbeat-body')).toHaveCount(0);
    } else {
        await expect(page.getByTestId('heartbeat-body')).toHaveText(sent.body, { useInnerText: false });
    }

    const release = await downloadUiRelease(UI_RELEASES.installed, caCertificatePem);
    const bundle = await openCheck(page, 'UI bundle');
    await expect(factValue(bundle, 'Served version')).toHaveText(UI_RELEASES.installed);
    await expect.poll(() => shownSha256(factValue(bundle, 'SHA-256'))).toBe(release.archiveSha256);
});
