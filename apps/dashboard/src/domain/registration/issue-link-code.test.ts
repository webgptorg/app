import { LinkCode } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { testOrgId } from '../../testing/billing-fixtures';
import { createTestEngine, engineRecord } from '../../testing/test-engine';
import { createTestRegistration, REGISTRATION_START_MS as NOW } from '../../testing/test-registration';
import { sha256Hex } from '../auth/secrets';
import type { LinkCodeId } from '../ids';
import { LINK_CODE_TTL_MS } from './issue-link-code';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function setup(options: { readonly linkCodeTtlMs?: number } = {}) {
    const registration = createTestRegistration(options);
    const orgId = testOrgId();
    return { ...registration, orgId, issue: (org = orgId) => registration.tryIssue(org) };
}

describe('issueLinkCode', () => {
    it('returns a C-03 link code valid for 30 days and stores only its SHA-256', async () => {
        const t = setup();
        const outcome = await t.issue();
        if (outcome.kind !== 'issued') {
            throw new Error('expected a code');
        }
        expect(LinkCode.parse(outcome.linkCode)).toBe(outcome.linkCode);
        expect(outcome.expiresAt).toBe(NOW + LINK_CODE_TTL_MS);
        const stored = [...t.stores.state.linkCodes.values()];
        expect(stored).toEqual([
            {
                id: outcome.linkCodeId,
                codeHash: await sha256Hex(outcome.linkCode),
                orgId: t.orgId,
                createdByUserId: expect.any(String) as string,
                createdAt: NOW,
                expiresAt: NOW + LINK_CODE_TTL_MS,
                usedAt: null,
                engineId: null,
            },
        ]);
        expect(JSON.stringify(stored)).not.toContain(outcome.linkCode);
        expect(outcome.linkCodeId).toMatch(/^[a-z2-7]{26}$/);
        expect(outcome.linkCode).not.toContain(outcome.linkCodeId);
    });

    it('gives the code the configured lifetime', async () => {
        const t = setup({ linkCodeTtlMs: 30_000 });
        const outcome = await t.issue();
        if (outcome.kind !== 'issued') {
            throw new Error('expected a code');
        }
        expect(outcome.expiresAt).toBe(NOW + 30_000);
        expect(await t.unused(outcome.linkCode)).toBe(true);
        t.clock.advance(30_000);
        expect(await t.unused(outcome.linkCode)).toBe(false);
    });

    it('issues nothing to an organization without engines.create or at engines.max', async () => {
        const t = setup();
        t.entitlements.grant(t.orgId, { enginesCreate: false });
        expect(await t.issue()).toEqual({ kind: 'denied', reason: 'not-entitled' });
        t.entitlements.grant(t.orgId, { enginesCreate: true, enginesMax: 0 });
        expect(await t.issue()).toEqual({ kind: 'denied', reason: 'engine-limit' });
        t.entitlements.grant(t.orgId, { enginesMax: 1 });
        const engine = await createTestEngine();
        t.stores.state.engines.set(engine.engineId, engineRecord(engine, t.orgId));
        expect(await t.issue()).toEqual({ kind: 'denied', reason: 'engine-limit' });
        t.stores.state.engines.set(engine.engineId, engineRecord(engine, t.orgId, { status: 'suspended' }));
        expect((await t.issue()).kind).toBe('issued');
        expect(t.stores.state.linkCodes.size).toBe(1);
    });

    it('allows at most 100 active codes per organization, until one expires or is cancelled', async () => {
        const t = setup();
        const ids: LinkCodeId[] = [];
        for (let i = 0; i < 100; i++) {
            const outcome = await t.issue();
            if (outcome.kind === 'issued') {
                ids.push(outcome.linkCodeId);
            }
            t.clock.advance(HOUR);
        }
        expect(ids).toHaveLength(100);
        expect(await t.issue()).toEqual({ kind: 'denied', reason: 'link-code-limit' });
        expect((await t.issue(testOrgId())).kind).toBe('issued');
        expect(await t.stores.linkCodes.cancel(t.orgId, ids[0] as LinkCodeId, t.clock.nowMs())).toBe('cancelled');
        expect((await t.issue()).kind).toBe('issued');
        expect(await t.issue()).toEqual({ kind: 'denied', reason: 'link-code-limit' });
        t.clock.advance(LINK_CODE_TTL_MS);
        expect((await t.issue()).kind).toBe('issued');
    });

    it('allows at most 200 codes per hour per organization', async () => {
        const t = setup();
        for (let i = 0; i < 199; i++) {
            const outcome = await t.issue();
            expect(outcome.kind).toBe('issued');
            // Cancel each before the next, so only the hourly limit applies.
            if (outcome.kind === 'issued') {
                await t.stores.linkCodes.cancel(t.orgId, outcome.linkCodeId, t.clock.nowMs());
            }
            t.clock.advance(1_000);
        }
        const last = await Promise.all([t.issue(), t.issue()]);
        expect(last.map((result) => result.kind).sort()).toEqual(['denied', 'issued']);
        expect(last).toContainEqual({ kind: 'denied', reason: 'rate-limited' });
        t.clock.set(NOW + 60 * MINUTE - 1);
        expect(await t.issue()).toEqual({ kind: 'denied', reason: 'rate-limited' });
        t.clock.set(NOW + 60 * MINUTE);
        expect((await t.issue()).kind).toBe('issued');
    });
});
