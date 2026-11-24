import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import type { CheckOutcome } from '../../check';
import { runConformance } from '../../runner';
import type { FakeEngine, FakeEngineOptions, Tamper } from '../../testing/fake-engine';
import { createFakeEngine } from '../../testing/fake-engine';
import { ENGINE_API_SUITE } from './index';

const CHECKS = {
    permissions: 'engine-api.updates.permissions',
    checkNow: 'engine-api.updates.check-now',
    nextCheck: 'engine-api.updates.next-check-due',
} as const;

interface Setup {
    readonly options?: FakeEngineOptions;
    readonly prepare?: (fake: FakeEngine) => void | Promise<void>;
}

async function outcome(id: string, { options = {}, prepare }: Setup = {}): Promise<CheckOutcome> {
    const fake = await createFakeEngine(options);
    await prepare?.(fake);
    const report = await runConformance({
        target: fake.target,
        suites: [ENGINE_API_SUITE],
        filter: (check) => check.id === id,
        timeoutMs: 30_000,
        signal: AbortSignal.timeout(60_000),
        seed: 11,
    });
    const result = report.results.find((candidate) => candidate.id === id);
    if (!result) throw new Error(`no result for ${id}`);
    return result.outcome;
}

const path = (request: Request): string => new URL(request.url).pathname.slice('/api/v1'.length);
const isCheckNow = (request: Request) => request.method === 'POST' && path(request) === '/updates/ui/check';
const isSecurity = (request: Request) => request.method === 'GET' && path(request) === '/security';

/** Answers every check-now with a fresh check, as an engine without the rate limit or the permission would. */
const alwaysChecks: Tamper = (request, response) =>
    isCheckNow(request) && response.status !== 200
        ? Response.json({
              at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
              outcome: 'up-to-date',
              version: '1.0.0',
              reason: null,
              revocationReason: null,
              eligibleAt: null,
          })
        : response;

function securityWith(change: (ui: Record<string, unknown>) => Record<string, unknown>): Tamper {
    return async (request, response) => {
        if (!isSecurity(request) || response.status !== 200) return response;
        const overview = (await response.json()) as { ui: Record<string, unknown> };
        return Response.json({ ...overview, ui: change(overview.ui) });
    };
}

const NO_UPDATES = Object.values(KNOWN_CAPABILITIES).filter((ref) => ref !== KNOWN_CAPABILITIES.updates);

describe('the updates checks', () => {
    it.each(Object.values(CHECKS))('pass against the in-memory engine: %s', async (id) => {
        expect(await outcome(id)).toEqual({ kind: 'pass' });
    });

    it.each(Object.values(CHECKS))('skip without the capability: %s', async (id) => {
        expect(await outcome(id, { options: { capabilities: NO_UPDATES } })).toEqual({
            kind: 'skip',
            reason: 'capability-not-advertised',
        });
    });

    it('fail when a member without settings.manage can run a check', async () => {
        expect(await outcome(CHECKS.permissions, { options: { tamper: alwaysChecks } })).toMatchObject({
            kind: 'fail',
        });
    });

    it('fail without the rate limit', async () => {
        expect(await outcome(CHECKS.checkNow, { options: { tamper: alwaysChecks } })).toMatchObject({ kind: 'fail' });
    });

    it('fail when GET /security does not report the check it answered', async () => {
        const stale = securityWith((ui) => ({ ...ui, lastUpdateCheck: null }));
        expect(await outcome(CHECKS.checkNow, { options: { tamper: stale } })).toMatchObject({ kind: 'fail' });
    });

    it('pass under manual when nothing is scheduled, and fail if a check still is', async () => {
        const refuseManual: Tamper = (request, response) =>
            isCheckNow(request)
                ? Response.json(
                      { type: 'https://ptbk.io/problems/x', title: 'X', status: 409, code: 'update-policy-manual' },
                      { status: 409, headers: { 'content-type': 'application/problem+json' } },
                  )
                : response;
        const unscheduled = securityWith((ui) => ({ ...ui, nextCheckAt: null }));
        const manual: Tamper = async (request, response) => unscheduled(request, await refuseManual(request, response));
        expect(await outcome(CHECKS.checkNow, { options: { tamper: manual } })).toEqual({ kind: 'pass' });
        expect(await outcome(CHECKS.nextCheck, { options: { tamper: manual } })).toEqual({
            kind: 'skip',
            reason: 'policy-manual',
        });
        expect(await outcome(CHECKS.checkNow, { options: { tamper: refuseManual } })).toMatchObject({ kind: 'fail' });
    });

    it('fail when the next check is more than an hour away, long overdue or missing', async () => {
        const later = securityWith((ui) => ({
            ...ui,
            nextCheckAt: new Date(Date.parse((ui['lastUpdateCheck'] as { at: string }).at) + 2 * 3_600_000)
                .toISOString()
                .replace(/\.\d{3}Z$/, 'Z'),
        }));
        const overdue = securityWith((ui) => ({ ...ui, nextCheckAt: '2020-01-01T00:00:00Z' }));
        const missing = securityWith((ui) => ({ ...ui, nextCheckAt: null }));
        for (const tamper of [later, overdue, missing]) {
            expect(await outcome(CHECKS.nextCheck, { options: { tamper } })).toMatchObject({ kind: 'fail' });
        }
    });
});
