import { expect, isEngineUrl, test, uniqueEmail } from '../../src/dashboard.ts';
import { DASHBOARD_ORIGIN } from '../../src/stack.ts';

// security.md, "Our domains never load engine data": every dashboard screen that names an engine, browsed with a
// linked engine in the account, makes no request to an engine hostname (and none the CSP had to stop).
test('while on the dashboard, the browser makes no request to any engine hostname', async ({
    page,
    authenticator,
    dashboard,
    mockEngines,
    requestLog,
    cspViolations,
}) => {
    test.setTimeout(120_000);
    expect(authenticator).not.toBe('');
    await dashboard.signUp(uniqueEmail('requests'));
    await dashboard.subscribe();
    const { linkCode } = await dashboard.createLinkCode();
    const report = await mockEngines.register(linkCode);
    if (report.outcome !== 'registered') throw new Error(`registration: ${report.outcome}`);

    const rows = await dashboard.reloadEngineRows();
    await expect(rows.getByRole('link', { name: /^Open engine/ })).toHaveAttribute(
        'href',
        `https://${report.hostname}/`,
    );
    await page.waitForLoadState('networkidle');
    await rows.getByRole('link', { name: `${report.engineId.slice(0, 8)}…` }).click();
    await expect(page.getByRole('button', { name: 'Revoke engine' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    for (const path of ['/engines/new', '/billing', '/account', '/engines']) {
        await page.goto(`${DASHBOARD_ORIGIN}${path}`);
        await page.waitForLoadState('networkidle');
    }

    expect(requestLog.length).toBeGreaterThan(0);
    expect(requestLog.filter(isEngineUrl)).toEqual([]);
    expect(requestLog.filter((url) => new URL(url).origin !== DASHBOARD_ORIGIN)).toEqual([]);
    expect(cspViolations).toEqual([]);
});
