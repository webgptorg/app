import { EngineVersion } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { cryptoRandom } from '../adapters/crypto-random';
import { toBase64Url } from '../domain/auth/secrets';
import { newUserId, type OrgId } from '../domain/ids';
import type { EngineRecord, EngineStore } from '../domain/registration/engine-store';
import type { LinkCodeRecord, LinkCodeStore } from '../domain/registration/link-code-store';
import { createTestEngine, engineRecord, type TestEngine } from './test-engine';

const NOW = 1_800_000_000_000;
const TTL = 30 * 60 * 1000;

export interface RegistrationStoreFixture {
    readonly linkCodes: LinkCodeStore;
    readonly engines: EngineStore;
    addOrg(): Promise<OrgId>;
    /** What D-06's revocation and I-05's suspension will do; the ports have no write for it yet. */
    suspend(engine: EngineRecord, reason: string): Promise<void>;
}

function codeRecord(orgId: OrgId, overrides: Partial<LinkCodeRecord> = {}): LinkCodeRecord {
    return {
        codeHash: toBase64Url(cryptoRandom.bytes(32)),
        orgId,
        createdByUserId: newUserId(cryptoRandom),
        createdAt: NOW,
        expiresAt: NOW + TTL,
        ...overrides,
    };
}

/** One suite, run against the D1 and the in-memory link-code and engine stores. */
export function describeRegistrationStoreContract(name: string, makeFixture: () => RegistrationStoreFixture): void {
    describe(`LinkCodeStore and EngineStore contract: ${name}`, () => {
        let fixture: RegistrationStoreFixture;
        let orgA: OrgId;
        let orgB: OrgId;
        let engine: TestEngine;

        beforeEach(async () => {
            fixture = makeFixture();
            orgA = await fixture.addOrg();
            orgB = await fixture.addOrg();
            engine = await createTestEngine();
        });

        async function created(orgId = orgA): Promise<{ readonly code: LinkCodeRecord; readonly row: EngineRecord }> {
            const code = codeRecord(orgId);
            await fixture.linkCodes.insert(code);
            const row = engineRecord(engine, orgId, { createdAt: NOW + 1, updatedAt: NOW + 1 });
            expect(await fixture.linkCodes.redeemForNewEngine(code.codeHash, row)).toBe('redeemed');
            return { code, row };
        }

        it('finds a code by hash until it expires', async () => {
            const code = codeRecord(orgA);
            await fixture.linkCodes.insert(code);
            expect(await fixture.linkCodes.findRedeemable(code.codeHash, NOW)).toBe(orgA);
            expect(await fixture.linkCodes.findRedeemable(code.codeHash, NOW + TTL - 1)).toBe(orgA);
            expect(await fixture.linkCodes.findRedeemable(code.codeHash, NOW + TTL)).toBeNull();
            expect(await fixture.linkCodes.findRedeemable(codeRecord(orgA).codeHash, NOW)).toBeNull();
        });

        it('refuses a second code with the same hash', async () => {
            const code = codeRecord(orgA);
            await fixture.linkCodes.insert(code);
            await expect(fixture.linkCodes.insert(codeRecord(orgB, { codeHash: code.codeHash }))).rejects.toThrow();
        });

        it('counts active and recently issued codes per organization only', async () => {
            await fixture.linkCodes.insert(codeRecord(orgA));
            await fixture.linkCodes.insert(codeRecord(orgA, { createdAt: NOW - TTL, expiresAt: NOW }));
            await fixture.linkCodes.insert(codeRecord(orgB));
            await created(orgA);
            expect(await fixture.linkCodes.countActive(orgA, NOW)).toBe(1);
            expect(await fixture.linkCodes.countActive(orgB, NOW)).toBe(1);
            expect(await fixture.linkCodes.countIssuedSince(orgA, NOW - TTL - 1)).toBe(3);
            expect(await fixture.linkCodes.countIssuedSince(orgA, NOW - TTL)).toBe(2);
            expect(await fixture.linkCodes.countIssuedSince(orgB, NOW - TTL - 1)).toBe(1);
        });

        it('redeems a code once, inserting the engine in the code organization', async () => {
            const { code, row } = await created();
            expect(await fixture.engines.findForRegistration(engine.engineId)).toEqual(row);
            expect(await fixture.linkCodes.findRedeemable(code.codeHash, NOW + 2)).toBeNull();
            const other = await createTestEngine();
            expect(
                await fixture.linkCodes.redeemForNewEngine(
                    code.codeHash,
                    engineRecord(other, orgA, { createdAt: NOW + 2 }),
                ),
            ).toBe('conflict');
            expect(await fixture.engines.findForRegistration(other.engineId)).toBeNull();
        });

        it('changes nothing when the code is expired, belongs to another organization or the engine exists', async () => {
            const expired = codeRecord(orgA, { expiresAt: NOW });
            await fixture.linkCodes.insert(expired);
            expect(
                await fixture.linkCodes.redeemForNewEngine(
                    expired.codeHash,
                    engineRecord(engine, orgA, { createdAt: NOW }),
                ),
            ).toBe('conflict');
            const foreign = codeRecord(orgB);
            await fixture.linkCodes.insert(foreign);
            expect(
                await fixture.linkCodes.redeemForNewEngine(
                    foreign.codeHash,
                    engineRecord(engine, orgA, { createdAt: NOW }),
                ),
            ).toBe('conflict');
            expect(await fixture.engines.findForRegistration(engine.engineId)).toBeNull();
            await created(orgA);
            const again = codeRecord(orgA);
            await fixture.linkCodes.insert(again);
            expect(
                await fixture.linkCodes.redeemForNewEngine(
                    again.codeHash,
                    engineRecord(engine, orgA, { createdAt: NOW + 5 }),
                ),
            ).toBe('conflict');
            expect(await fixture.linkCodes.findRedeemable(again.codeHash, NOW + 5)).toBe(orgA);
            expect(await fixture.linkCodes.findRedeemable(foreign.codeHash, NOW + 5)).toBe(orgB);
        });

        it('refreshes an active engine of the code organization with a new code', async () => {
            const { row } = await created();
            const code = codeRecord(orgA);
            await fixture.linkCodes.insert(code);
            const refresh = {
                engineId: engine.engineId,
                orgId: orgA,
                mode: 'direct',
                engineVersion: EngineVersion.parse('2.0.0'),
                now: NOW + 10,
            } as const;
            expect(await fixture.linkCodes.redeemForExistingEngine(code.codeHash, refresh)).toBe('redeemed');
            expect(await fixture.engines.findForRegistration(engine.engineId)).toEqual({
                ...row,
                mode: 'direct',
                engineVersion: '2.0.0',
                updatedAt: NOW + 10,
            });
            expect(await fixture.linkCodes.findRedeemable(code.codeHash, NOW + 10)).toBeNull();
            expect(await fixture.linkCodes.redeemForExistingEngine(code.codeHash, { ...refresh, now: NOW + 11 })).toBe(
                'conflict',
            );
        });

        it('refreshes neither a suspended engine nor one of another organization, and keeps the code', async () => {
            const { row } = await created();
            const foreign = codeRecord(orgB);
            await fixture.linkCodes.insert(foreign);
            const refresh = {
                engineId: engine.engineId,
                mode: 'direct',
                engineVersion: EngineVersion.parse('2.0.0'),
                now: NOW + 10,
            } as const;
            expect(await fixture.linkCodes.redeemForExistingEngine(foreign.codeHash, { ...refresh, orgId: orgB })).toBe(
                'conflict',
            );
            await fixture.suspend(row, 'owner-revoked');
            const code = codeRecord(orgA);
            await fixture.linkCodes.insert(code);
            expect(await fixture.linkCodes.redeemForExistingEngine(code.codeHash, { ...refresh, orgId: orgA })).toBe(
                'conflict',
            );
            expect(await fixture.linkCodes.findRedeemable(code.codeHash, NOW + 10)).toBe(orgA);
            expect(await fixture.linkCodes.findRedeemable(foreign.codeHash, NOW + 10)).toBe(orgB);
            expect(await fixture.engines.findForRegistration(engine.engineId)).toEqual({
                ...row,
                status: 'suspended',
                statusReason: 'owner-revoked',
            });
        });

        it('counts only the organization’s own active engines', async () => {
            const { row } = await created(orgA);
            expect(await fixture.engines.countActive(orgA)).toBe(1);
            expect(await fixture.engines.countActive(orgB)).toBe(0);
            await fixture.suspend(row, 'owner-revoked');
            expect(await fixture.engines.countActive(orgA)).toBe(0);
        });
    });
}
