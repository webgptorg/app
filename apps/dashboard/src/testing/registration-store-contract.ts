import { EngineVersion } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { cryptoRandom } from '../adapters/crypto-random';
import { toBase64Url } from '../domain/auth/secrets';
import { newLinkCodeId, newOrgAuditEntryId, newUserId, type OrgId } from '../domain/ids';
import type { AdminAuditEntry } from '../domain/auth/records';
import type { PlatformEngineStore } from '../domain/engines/platform-engine-store';
import { newAdminAuditEntryId } from '../domain/ids';
import type { EngineRecord, EngineStore, OrgEngineAudit } from '../domain/registration/engine-store';
import type { LinkCodeRecord, LinkCodeStore } from '../domain/registration/link-code-store';
import { engineLabelSchema } from '../shared/engine-label';
import type { StoredOrgAuditEntry } from './memory-registration-store';
import { createTestEngine, engineRecord, type TestEngine } from './test-engine';

const NOW = 1_800_000_000_000;
const TTL = 30 * 60 * 1000;

export interface RegistrationStoreFixture {
    readonly linkCodes: LinkCodeStore;
    readonly engines: EngineStore;
    readonly platformEngines: PlatformEngineStore;
    addOrg(): Promise<OrgId>;
    /** Sets the engine's row directly, e.g. to a status reason no write produces. */
    suspend(engine: EngineRecord, reason: string): Promise<void>;
    /** The `admin_audit_log` entries about one engine, oldest first. */
    adminAudit(engineId: string): Promise<readonly AdminAuditEntry[]>;
    /** The organization's `org_audit_log` rows, oldest first; the repository itself has no read. */
    orgAudit(orgId: OrgId): Promise<readonly StoredOrgAuditEntry[]>;
}

function audit(at: number): OrgEngineAudit {
    return { id: newOrgAuditEntryId(cryptoRandom), actorUserId: newUserId(cryptoRandom), at };
}

function adminAudit(action: string, engineId: string, at: number): AdminAuditEntry {
    return {
        id: newAdminAuditEntryId(cryptoRandom),
        adminUserId: newUserId(cryptoRandom),
        action,
        targetType: 'engine',
        targetId: engineId,
        reason: 'Report #1',
        createdAt: at,
    };
}

function codeRecord(orgId: OrgId, overrides: Partial<LinkCodeRecord> = {}): LinkCodeRecord {
    return {
        id: newLinkCodeId(cryptoRandom),
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

        async function created(
            orgId = orgA,
            at = NOW + 1,
        ): Promise<{ readonly code: LinkCodeRecord; readonly row: EngineRecord }> {
            const code = codeRecord(orgId);
            await fixture.linkCodes.insert(code);
            const row = engineRecord(engine, orgId, { createdAt: at, updatedAt: at });
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

        it('refuses a second code with the same ID', async () => {
            const code = codeRecord(orgA);
            await fixture.linkCodes.insert(code);
            await expect(fixture.linkCodes.insert(codeRecord(orgA, { id: code.id }))).rejects.toThrow();
        });

        it('tells the organization whether its code is pending, expired or linked, and nobody else', async () => {
            const code = codeRecord(orgA);
            await fixture.linkCodes.insert(code);
            expect(await fixture.linkCodes.findState(orgA, code.id, NOW)).toEqual({
                kind: 'pending',
                expiresAt: NOW + TTL,
            });
            expect(await fixture.linkCodes.findState(orgA, code.id, NOW + TTL)).toEqual({ kind: 'expired' });
            expect(await fixture.linkCodes.findState(orgB, code.id, NOW)).toBeNull();
            expect(await fixture.linkCodes.findState(orgA, newLinkCodeId(cryptoRandom), NOW)).toBeNull();
        });

        it('keeps a redeemed code linked after it would have expired', async () => {
            const { code } = await created();
            const linked = { kind: 'linked', engineId: engine.engineId };
            expect(await fixture.linkCodes.findState(orgA, code.id, NOW + 2)).toEqual(linked);
            expect(await fixture.linkCodes.findState(orgA, code.id, NOW + TTL * 10)).toEqual(linked);
            expect(await fixture.linkCodes.findState(orgB, code.id, NOW + 2)).toBeNull();
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

        it('lists and finds only the organization’s own engines, oldest first', async () => {
            const { row: first } = await created(orgA, NOW + 1);
            engine = await createTestEngine();
            const { row: second } = await created(orgA, NOW + 2);
            engine = await createTestEngine();
            const { row: foreign } = await created(orgB);
            expect(await fixture.engines.listForOrg(orgA)).toEqual([first, second]);
            expect(await fixture.engines.listForOrg(orgB)).toEqual([foreign]);
            expect(await fixture.engines.findInOrg(orgA, first.engineId)).toEqual(first);
            expect(await fixture.engines.findInOrg(orgA, foreign.engineId)).toBeNull();
            expect(await fixture.engines.findInOrg(orgB, first.engineId)).toBeNull();
            expect(await fixture.engines.findInOrg(orgA, (await createTestEngine()).engineId)).toBeNull();
        });

        it('revokes an engine of the organization once, with one audit entry', async () => {
            const { row } = await created(orgA);
            const entry = audit(NOW + 20);
            expect(await fixture.engines.revoke(orgA, engine.engineId, entry)).toBe('revoked');
            expect(await fixture.engines.findInOrg(orgA, engine.engineId)).toEqual({
                ...row,
                status: 'suspended',
                statusReason: 'owner-revoked',
                updatedAt: NOW + 20,
            });
            expect(await fixture.orgAudit(orgA)).toEqual([
                {
                    id: entry.id,
                    orgId: orgA,
                    actorUserId: entry.actorUserId,
                    action: 'engine.revoke',
                    targetType: 'engine',
                    targetId: engine.engineId,
                    createdAt: NOW + 20,
                },
            ]);
            expect(await fixture.engines.revoke(orgA, engine.engineId, audit(NOW + 30))).toBe('already-revoked');
            expect(await fixture.engines.findInOrg(orgA, engine.engineId)).toMatchObject({ updatedAt: NOW + 20 });
            expect(await fixture.orgAudit(orgA)).toHaveLength(1);
        });

        it('turns a platform suspension into an owner revocation', async () => {
            const { row } = await created(orgA);
            await fixture.suspend(row, 'abuse');
            expect(await fixture.engines.revoke(orgA, engine.engineId, audit(NOW + 20))).toBe('revoked');
            expect(await fixture.engines.findInOrg(orgA, engine.engineId)).toMatchObject({
                status: 'suspended',
                statusReason: 'owner-revoked',
            });
            expect(await fixture.orgAudit(orgA)).toHaveLength(1);
        });

        it('cannot revoke another organization’s engine or one that does not exist', async () => {
            const { row } = await created(orgA);
            expect(await fixture.engines.revoke(orgB, engine.engineId, audit(NOW + 20))).toBe('not-found');
            expect(await fixture.engines.revoke(orgA, (await createTestEngine()).engineId, audit(NOW + 20))).toBe(
                'not-found',
            );
            expect(await fixture.engines.findInOrg(orgA, engine.engineId)).toEqual(row);
            expect(await fixture.orgAudit(orgA)).toEqual([]);
            expect(await fixture.orgAudit(orgB)).toEqual([]);
        });

        it('sets, keeps and clears the owner’s label, with one audit entry per change and never the label', async () => {
            const { row } = await created(orgA);
            const label = engineLabelSchema.parse('Produkce – Brno (2)');
            const entry = audit(NOW + 20);
            expect(await fixture.engines.rename(orgA, engine.engineId, label, entry)).toBe('renamed');
            expect(await fixture.engines.findInOrg(orgA, engine.engineId)).toEqual({
                ...row,
                label,
                updatedAt: NOW + 20,
            });
            expect(await fixture.orgAudit(orgA)).toEqual([
                {
                    id: entry.id,
                    orgId: orgA,
                    actorUserId: entry.actorUserId,
                    action: 'engine.rename',
                    targetType: 'engine',
                    targetId: engine.engineId,
                    createdAt: NOW + 20,
                },
            ]);
            expect(await fixture.engines.rename(orgA, engine.engineId, label, audit(NOW + 30))).toBe('unchanged');
            expect(await fixture.engines.findInOrg(orgA, engine.engineId)).toMatchObject({ updatedAt: NOW + 20 });
            expect(await fixture.orgAudit(orgA)).toHaveLength(1);
            expect(await fixture.engines.rename(orgA, engine.engineId, null, audit(NOW + 40))).toBe('renamed');
            expect(await fixture.engines.findInOrg(orgA, engine.engineId)).toMatchObject({ label: null });
            expect(await fixture.engines.rename(orgA, engine.engineId, null, audit(NOW + 50))).toBe('unchanged');
            expect((await fixture.orgAudit(orgA)).map((logged) => logged.action)).toEqual([
                'engine.rename',
                'engine.rename',
            ]);
        });

        it('keeps the label when the engine re-registers or is revoked', async () => {
            await created(orgA);
            const label = engineLabelSchema.parse('Staging');
            await fixture.engines.rename(orgA, engine.engineId, label, audit(NOW + 5));
            const code = codeRecord(orgA);
            await fixture.linkCodes.insert(code);
            const refresh = {
                engineId: engine.engineId,
                orgId: orgA,
                mode: 'tunnel',
                engineVersion: EngineVersion.parse('2.0.0'),
                now: NOW + 10,
            } as const;
            expect(await fixture.linkCodes.redeemForExistingEngine(code.codeHash, refresh)).toBe('redeemed');
            expect(await fixture.engines.revoke(orgA, engine.engineId, audit(NOW + 20))).toBe('revoked');
            expect(await fixture.engines.findInOrg(orgA, engine.engineId)).toMatchObject({
                label,
                status: 'suspended',
            });
        });

        it('cannot rename another organization’s engine or one that does not exist', async () => {
            const { row } = await created(orgA);
            const label = engineLabelSchema.parse('Mine now');
            expect(await fixture.engines.rename(orgB, engine.engineId, label, audit(NOW + 20))).toBe('not-found');
            expect(await fixture.engines.rename(orgA, (await createTestEngine()).engineId, label, audit(NOW))).toBe(
                'not-found',
            );
            expect(await fixture.engines.findInOrg(orgA, engine.engineId)).toEqual(row);
            expect(await fixture.orgAudit(orgA)).toEqual([]);
            expect(await fixture.orgAudit(orgB)).toEqual([]);
        });

        it('logs a concurrent double revocation once', async () => {
            await created(orgA);
            const outcomes = await Promise.all([
                fixture.engines.revoke(orgA, engine.engineId, audit(NOW + 20)),
                fixture.engines.revoke(orgA, engine.engineId, audit(NOW + 20)),
            ]);
            expect([...outcomes].sort()).toEqual(['already-revoked', 'revoked']);
            expect(await fixture.orgAudit(orgA)).toHaveLength(1);
        });
        describe('platform suspension (I-05)', () => {
            it('suspends an active engine of any organization once, with one audit entry', async () => {
                const { row } = await created(orgB);
                const entry = adminAudit('admin.engine.suspend', engine.engineId, NOW + 20);
                expect(await fixture.platformEngines.find(engine.engineId)).toEqual(row);
                expect(await fixture.platformEngines.suspend(engine.engineId, entry)).toBe('suspended');
                const suspended = {
                    ...row,
                    status: 'suspended',
                    statusReason: 'platform-suspended',
                    updatedAt: NOW + 20,
                };
                expect(await fixture.platformEngines.find(engine.engineId)).toEqual(suspended);
                expect(await fixture.adminAudit(engine.engineId)).toEqual([entry]);
                expect(
                    await fixture.platformEngines.suspend(
                        engine.engineId,
                        adminAudit('admin.engine.suspend', engine.engineId, NOW + 30),
                    ),
                ).toBe('already-suspended');
                expect(await fixture.platformEngines.find(engine.engineId)).toEqual(suspended);
                expect(await fixture.adminAudit(engine.engineId)).toEqual([entry]);
                expect(await fixture.engines.countActive(orgB)).toBe(0);
            });

            it('lifts a platform suspension with its own audit entry, and nothing else', async () => {
                const { row } = await created(orgA);
                expect(
                    await fixture.platformEngines.unsuspend(
                        engine.engineId,
                        adminAudit('admin.engine.unsuspend', engine.engineId, NOW + 10),
                    ),
                ).toBe('not-suspended');
                await fixture.platformEngines.suspend(
                    engine.engineId,
                    adminAudit('admin.engine.suspend', engine.engineId, NOW + 20),
                );
                const lift = adminAudit('admin.engine.unsuspend', engine.engineId, NOW + 30);
                expect(await fixture.platformEngines.unsuspend(engine.engineId, lift)).toBe('unsuspended');
                expect(await fixture.platformEngines.find(engine.engineId)).toEqual({ ...row, updatedAt: NOW + 30 });
                expect((await fixture.adminAudit(engine.engineId)).map((entry) => entry.action)).toEqual([
                    'admin.engine.suspend',
                    'admin.engine.unsuspend',
                ]);
                await fixture.suspend(row, 'unpaid');
                expect(
                    await fixture.platformEngines.unsuspend(
                        engine.engineId,
                        adminAudit('admin.engine.unsuspend', engine.engineId, NOW + 40),
                    ),
                ).toBe('not-suspended');
                expect(await fixture.adminAudit(engine.engineId)).toHaveLength(2);
            });

            it('never lifts an owner revocation', async () => {
                const { row } = await created(orgA);
                expect(await fixture.engines.revoke(orgA, engine.engineId, audit(NOW + 10))).toBe('revoked');
                const revoked = await fixture.platformEngines.find(engine.engineId);
                expect(revoked).toMatchObject({ status: 'suspended', statusReason: 'owner-revoked' });
                for (const at of [NOW + 20, NOW + 30]) {
                    expect(
                        await fixture.platformEngines.unsuspend(
                            engine.engineId,
                            adminAudit('admin.engine.unsuspend', engine.engineId, at),
                        ),
                    ).toBe('owner-revoked');
                }
                expect(
                    await fixture.platformEngines.suspend(
                        engine.engineId,
                        adminAudit('admin.engine.suspend', engine.engineId, NOW + 40),
                    ),
                ).toBe('already-suspended');
                expect(await fixture.platformEngines.find(engine.engineId)).toEqual(revoked);
                expect(await fixture.adminAudit(engine.engineId)).toEqual([]);
                expect(row.status).toBe('active');
            });

            it('answers not-found for an engine that does not exist, writing nothing', async () => {
                const unknown = (await createTestEngine()).engineId;
                expect(await fixture.platformEngines.find(unknown)).toBeNull();
                expect(
                    await fixture.platformEngines.suspend(unknown, adminAudit('admin.engine.suspend', unknown, NOW)),
                ).toBe('not-found');
                expect(
                    await fixture.platformEngines.unsuspend(
                        unknown,
                        adminAudit('admin.engine.unsuspend', unknown, NOW),
                    ),
                ).toBe('not-found');
                expect(await fixture.adminAudit(unknown)).toEqual([]);
            });

            it('logs a concurrent double suspension once', async () => {
                await created(orgA);
                const outcomes = await Promise.all([
                    fixture.platformEngines.suspend(
                        engine.engineId,
                        adminAudit('admin.engine.suspend', engine.engineId, NOW + 20),
                    ),
                    fixture.platformEngines.suspend(
                        engine.engineId,
                        adminAudit('admin.engine.suspend', engine.engineId, NOW + 20),
                    ),
                ]);
                expect([...outcomes].sort()).toEqual(['already-suspended', 'suspended']);
                expect(await fixture.adminAudit(engine.engineId)).toHaveLength(1);
            });
        });
    });
}
