import { LinkCode } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { testOrgId } from '../../testing/billing-fixtures';
import { createTestEngine, engineRecord } from '../../testing/test-engine';
import { createTestRegistration, REGISTRATION_START_MS as NOW } from '../../testing/test-registration';
import { sha256Hex } from '../auth/secrets';
import { LINK_CODE_LIMITS } from './engine-creation-policy';
import { LINK_CODE_TTL_MS } from './issue-link-code';

const MINUTE = 60_000;

function setup(options: { readonly linkCodeTtlMs?: number } = {}) {
    const registration = createTestRegistration(options);
    const orgId = testOrgId();
    return { ...registration, orgId, issue: (org = orgId) => registration.tryIssue(org) };
}

describe('issueLinkCode', () => {
    it('returns a C-03 link code valid for 30 minutes and stores only its SHA-256', async () => {
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

    it('allows at most 5 active codes per organization', async () => {
        const t = setup();
        for (let i = 0; i < LINK_CODE_LIMITS.active; i++) {
            expect((await t.issue()).kind).toBe('issued');
        }
        expect(await t.issue()).toEqual({ kind: 'denied', reason: 'rate-limited' });
        expect((await t.issue(testOrgId())).kind).toBe('issued');
        t.clock.advance(LINK_CODE_TTL_MS);
        expect((await t.issue()).kind).toBe('issued');
    });

    it('allows at most 10 codes per hour per organization', async () => {
        const t = setup();
        for (let i = 0; i < LINK_CODE_LIMITS.perHour; i++) {
            expect((await t.issue()).kind).toBe('issued');
            // Expire each before the next, so only the hourly limit applies.
            t.clock.advance(LINK_CODE_TTL_MS / 5);
        }
        t.clock.set(NOW + 60 * MINUTE - 1);
        expect(await t.issue()).toEqual({ kind: 'denied', reason: 'rate-limited' });
        t.clock.set(NOW + 60 * MINUTE);
        expect((await t.issue()).kind).toBe('issued');
    });
});
