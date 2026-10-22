import { expect, test, uniqueEmail } from '../../src/dashboard.ts';
import { DASHBOARD_TIMING } from '../../src/stack.ts';

const { heartbeatIntervalS, missedLimit, graceS } = DASHBOARD_TIMING;
const OFFLINE_AFTER_S = missedLimit * heartbeatIntervalS + graceS;

test('a stopped engine shows offline after the missed-heartbeat threshold', async ({
    authenticator,
    dashboard,
    mockEngines,
}) => {
    test.setTimeout(240_000);
    expect(authenticator).not.toBe('');
    await dashboard.signUp(uniqueEmail('offline'));
    await dashboard.subscribe();
    const { linkCode } = await dashboard.createLinkCode();
    const engine = await mockEngines.start(linkCode);

    const status = async (): Promise<string> => {
        const rows = await dashboard.reloadEngineRows();
        if ((await rows.count()) !== 1) return 'not listed';
        for (const candidate of ['Online', 'Offline']) {
            if ((await rows.getByText(candidate, { exact: true }).count()) === 1) return candidate;
        }
        return 'other';
    };
    await expect.poll(status, { timeout: 60_000, intervals: [1_000, 2_000] }).toBe('Online');

    await engine.stop();
    const stoppedAt = Date.now();
    await expect.poll(status, { timeout: (OFFLINE_AFTER_S + 30) * 1000, intervals: [2_000] }).toBe('Offline');
    // The last heartbeat came at most one interval before the stop, so an earlier "offline" ignored the threshold.
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual((OFFLINE_AFTER_S - heartbeatIntervalS) * 1000);
});
