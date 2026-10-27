import { expect, test, uniqueEmail } from '../../src/dashboard.ts';
import { DASHBOARD_TIMING } from '../../src/stack.ts';

// Each engine here has a fresh key and only registers (`register --link`): the refusals happen at registration.

test('a used link code links no second engine', async ({ dashboard, mockEngines }) => {
    test.setTimeout(120_000);
    await dashboard.signUp(uniqueEmail('reuse'));
    await dashboard.subscribe();
    const { linkCode } = await dashboard.createLinkCode();

    const first = await mockEngines.register(linkCode);
    expect(first.outcome).toBe('registered');
    expect(await mockEngines.register(linkCode)).toEqual({ outcome: 'rejected', reason: 'invalid-link-code' });

    await expect(await dashboard.reloadEngineRows()).toHaveCount(1);
});

test('an expired link code is refused at registration', async ({ page, dashboard, mockEngines }) => {
    test.setTimeout(120_000);
    await dashboard.signUp(uniqueEmail('expired'));
    await dashboard.subscribe();
    const { linkCode } = await dashboard.createLinkCode();

    // The page counts down from the dashboard's expiry (LINK_CODE_TTL_S), so its banner says when the code is gone. The
    // link progress repeats it, on screen and in its live region (D-10).
    await expect(page.getByText('The link code expired').first()).toBeVisible({
        timeout: (DASHBOARD_TIMING.linkCodeTtlS + 10) * 1000,
    });
    expect(await mockEngines.register(linkCode)).toEqual({ outcome: 'rejected', reason: 'invalid-link-code' });

    await expect(await dashboard.reloadEngineRows()).toHaveCount(0);
});
