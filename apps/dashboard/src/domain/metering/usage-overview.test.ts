import { expect, it } from 'vitest';

import { createFakeEntitlements } from '../../testing/fake-entitlements';
import { testFacts } from '../../testing/test-metering';
import { readUsageOverview } from './usage-overview';

it('answers every meter’s reading with the limits the entitlements set, unlimited where a meter has no quota', async () => {
    const { facts } = testFacts();
    const entitlements = createFakeEntitlements({
        enginesCreate: true,
        enginesMax: 5,
        meterQuotas: { 'agents.per-project.max': 10 },
        overLimit: 'warn',
    });
    const overview = await readUsageOverview(
        { entitlements, store: { readOrgFacts: () => Promise.resolve(facts) } },
        facts.orgId,
        new AbortController().signal,
    );
    expect(overview.overLimit).toBe('warn');
    expect(overview.meters.map(({ meter, limits }) => ({ meter, limits }))).toEqual([
        { meter: 'projects', limits: { org: 5, project: null } },
        { meter: 'agents', limits: { org: null, project: 10 } },
        { meter: 'members', limits: { org: null, project: null } },
        { meter: 'people', limits: { org: null, project: null } },
    ]);
    expect(overview.meters[1]?.reading.org).toEqual({ value: 5, unreported: 2 });
});
