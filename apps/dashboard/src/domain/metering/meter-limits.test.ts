import { describe, expect, it } from 'vitest';

import { createFakeEntitlements, type FakeEntitlementGrant } from '../../testing/fake-entitlements';
import { testFacts } from '../../testing/test-metering';
import { checkMeterLimit, type MeterLimitRequest } from './meter-limits';

const signal = new AbortController().signal;
const { facts, engines } = testFacts();

function check(grant: Partial<FakeEntitlementGrant>, request: MeterLimitRequest) {
    const entitlements = createFakeEntitlements();
    entitlements.grant(facts.orgId, grant);
    return checkMeterLimit(
        { entitlements, store: { readOrgFacts: () => Promise.resolve(facts) } },
        facts.orgId,
        request,
        signal,
    );
}

describe('checkMeterLimit', () => {
    it('lets anything through without a limit', async () => {
        expect(await check({ enginesMax: null }, { meter: 'projects', adding: 1 })).toEqual({ outcome: 'ok' });
        // Projects have no per-project quota, so naming one checks the organization's only.
        expect(await check({ enginesMax: 9 }, { meter: 'projects', adding: 1, engineId: engines.reporting })).toEqual({
            outcome: 'ok',
        });
        expect(await check({}, { meter: 'agents', adding: 50, engineId: engines.reporting })).toEqual({
            outcome: 'ok',
        });
    });

    it('allows up to the limit and blocks one past it, on a plan that blocks', async () => {
        expect(await check({ enginesMax: 4 }, { meter: 'projects', adding: 1 })).toEqual({ outcome: 'ok' });
        expect(await check({ enginesMax: 3 }, { meter: 'projects', adding: 1 })).toEqual({
            outcome: 'block',
            meter: 'projects',
            scope: 'org',
            used: 3,
            limit: 3,
        });
    });

    it('only warns on a plan that warns', async () => {
        expect(await check({ enginesMax: 3, overLimit: 'warn' }, { meter: 'projects', adding: 1 })).toMatchObject({
            outcome: 'warn',
            used: 3,
            limit: 3,
        });
    });

    it('never blocks what an engine creates, whatever the plan says', async () => {
        expect(
            await check(
                { meterQuotas: { 'agents.max': 5 } },
                { meter: 'agents', adding: 1, engineId: engines.reporting },
            ),
        ).toEqual({ outcome: 'warn', meter: 'agents', scope: 'org', used: 5, limit: 5 });
    });

    it('checks a project’s own quota for the project the action adds to', async () => {
        const grant = { meterQuotas: { 'agents.per-project.max': 5 } };
        expect(await check(grant, { meter: 'agents', adding: 1, engineId: engines.reporting })).toMatchObject({
            outcome: 'warn',
            scope: 'project',
            used: 5,
            limit: 5,
        });
        expect(await check(grant, { meter: 'agents', adding: 1, engineId: engines.silent })).toEqual({ outcome: 'ok' });
        expect(await check(grant, { meter: 'agents', adding: 6 })).toEqual({ outcome: 'ok' });
    });

    it('does not count unreported projects as over a limit', async () => {
        expect(await check({ meterQuotas: { 'agents.max': 5 } }, { meter: 'agents', adding: 0 })).toEqual({
            outcome: 'ok',
        });
    });

    it('limits the dashboard’s people for the organization, a meter without a per-project quota', async () => {
        expect(
            await check(
                { meterQuotas: { 'people.max': 4 } },
                { meter: 'people', adding: 1, engineId: engines.reporting },
            ),
        ).toEqual({ outcome: 'block', meter: 'people', scope: 'org', used: 4, limit: 4 });
    });

    it('ignores a project the organization does not have', async () => {
        const { engines: elsewhere } = testFacts();
        expect(
            await check(
                { meterQuotas: { 'agents.per-project.max': 0 } },
                { meter: 'agents', adding: 1, engineId: elsewhere.reporting },
            ),
        ).toEqual({ outcome: 'ok' });
    });

    it('tells whoever listens of every shortfall, and of nothing else', async () => {
        const told: unknown[] = [];
        const entitlements = createFakeEntitlements();
        entitlements.grant(facts.orgId, { enginesMax: 3, overLimit: 'warn' });
        const deps = {
            entitlements,
            store: { readOrgFacts: () => Promise.resolve(facts) },
            onLimit: (orgId: string, shortfall: unknown) => {
                told.push([orgId, shortfall]);
                return Promise.resolve();
            },
        };
        await checkMeterLimit(deps, facts.orgId, { meter: 'projects', adding: 1 }, signal);
        await checkMeterLimit(deps, facts.orgId, { meter: 'agents', adding: 1 }, signal);
        expect(told).toEqual([[facts.orgId, { outcome: 'warn', meter: 'projects', scope: 'org', used: 3, limit: 3 }]]);
    });
});
