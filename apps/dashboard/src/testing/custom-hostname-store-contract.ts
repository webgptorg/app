import { Hostname, type EngineId } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { cryptoRandom } from '../adapters/crypto-random';
import type { AdminAuditEntry } from '../domain/auth/records';
import type { CustomHostnameRecord, CustomHostnameStore } from '../domain/custom-hostnames/custom-hostname-store';
import { hostnameAuditEntry, type HostnameAuditAction } from '../domain/custom-hostnames/hostname-audit';
import type { OrgId } from '../domain/ids';
import type { EngineHostnameStore } from '../domain/registry/engine-hostname-store';
import { createFakeClock } from '../adapters/fake-clock';
import { signClaim, TEST_ADMIN } from './test-custom-hostnames';
import { createTestEngine, type TestEngine } from './test-engine';

const NOW = 1_800_000_000_000;

export interface CustomHostnameStoreFixture {
    readonly store: CustomHostnameStore & EngineHostnameStore;
    /** A registered engine in a new organization. */
    addEngine(): Promise<{ readonly engine: TestEngine; readonly orgId: OrgId }>;
    /** Every `admin_audit_log` entry whose target is one of the engine's hostnames. */
    auditFor(engineId: EngineId): Promise<readonly AdminAuditEntry[]>;
}

/** One suite, run against the D1 and the in-memory `engine_hostnames`. */
export function describeCustomHostnameStoreContract(name: string, makeFixture: () => CustomHostnameStoreFixture): void {
    describe(`CustomHostnameStore contract: ${name}`, () => {
        let fixture: CustomHostnameStoreFixture;
        let engine: TestEngine;
        let orgId: OrgId;
        const clock = createFakeClock(NOW);

        beforeEach(async () => {
            fixture = makeFixture();
            ({ engine, orgId } = await fixture.addEngine());
            suffix = engine.engineId;
        });

        const audit = (action: HostnameAuditAction, hostname: Hostname, owner = engine) =>
            hostnameAuditEntry({ clock, random: cryptoRandom }, TEST_ADMIN, action, owner.engineId, hostname);

        /** Unique per test: the workers project keeps one D1 database for the whole file. */
        let suffix = '';
        const name = (label: string) => `${label}.${suffix}.customer.example`;

        async function record(
            hostname: string,
            overrides: Partial<CustomHostnameRecord> = {},
            owner = engine,
        ): Promise<CustomHostnameRecord> {
            return {
                hostname: Hostname.parse(hostname),
                engineId: owner.engineId,
                orgId,
                claimSig: await signClaim(owner, hostname, owner.engineId),
                status: 'pending-dns',
                dnsCheckedAt: null,
                createdAt: NOW,
                createdByUserId: TEST_ADMIN,
                ...overrides,
            };
        }

        async function inserted(hostname: string, overrides: Partial<CustomHostnameRecord> = {}) {
            const row = await record(hostname, overrides);
            expect(await fixture.store.insert(row, audit('engine.hostname.add', row.hostname))).toBe('inserted');
            return row;
        }

        it('finds the engine with its organization and key, and nothing for an unknown one', async () => {
            expect(await fixture.store.findEngine(engine.engineId)).toEqual({ orgId, publicKey: engine.publicKey });
            expect(await fixture.store.findEngine((await createTestEngine()).engineId)).toBeNull();
        });

        it('inserts with its audit entry, lists oldest first and finds by engine and hostname', async () => {
            const later = await inserted(name('b'), { createdAt: NOW + 1 });
            const first = await inserted(name('a'));
            expect(await fixture.store.listForEngine(engine.engineId)).toEqual([first, later]);
            expect(await fixture.store.find(engine.engineId, first.hostname)).toEqual(first);
            expect(await fixture.store.isAssigned(first.hostname)).toBe(true);
            expect(await fixture.store.isAssigned(Hostname.parse(name('c')))).toBe(false);
            expect((await fixture.auditFor(engine.engineId)).map((entry) => entry.targetId).sort()).toEqual([
                `${engine.engineId}/${name('a')}`,
                `${engine.engineId}/${name('b')}`,
            ]);
        });

        it('refuses a hostname another engine has, writing no audit entry', async () => {
            const { engine: other } = await fixture.addEngine();
            const row = await inserted(name('a'));
            const taken = await record(name('a'), {}, other);
            expect(await fixture.store.insert(taken, audit('engine.hostname.add', row.hostname, other))).toBe('taken');
            expect(await fixture.store.find(other.engineId, row.hostname)).toBeNull();
            expect(await fixture.auditFor(other.engineId)).toEqual([]);
        });

        it('serves only active rows as claims to the registry', async () => {
            const pending = await inserted(name('a'));
            const active = await inserted(name('b'), { status: 'active', dnsCheckedAt: NOW });
            expect(await fixture.store.activeCustomHostnames(engine.engineId)).toEqual([
                { hostname: active.hostname, sig: active.claimSig },
            ]);
            expect(
                await fixture.store.recordDnsCheck(
                    engine.engineId,
                    pending.hostname,
                    { status: 'active', checkedAt: NOW + 5 },
                    null,
                ),
            ).toBe('updated');
            expect((await fixture.store.activeCustomHostnames(engine.engineId)).map((c) => c.hostname)).toEqual([
                pending.hostname,
                active.hostname,
            ]);
            expect(await fixture.store.find(engine.engineId, pending.hostname)).toMatchObject({
                status: 'active',
                dnsCheckedAt: NOW + 5,
            });
            expect(await fixture.auditFor(engine.engineId)).toHaveLength(2);
        });

        it('records a DNS check with its audit entry, and nothing for a row of another engine', async () => {
            const { engine: other } = await fixture.addEngine();
            const row = await inserted(name('a'));
            const check = { status: 'active', checkedAt: NOW + 5 } as const;
            const foreign = audit('engine.hostname.activate', row.hostname, other);
            expect(await fixture.store.recordDnsCheck(other.engineId, row.hostname, check, foreign)).toBe('not-found');
            expect(await fixture.auditFor(other.engineId)).toEqual([]);
            const entry = audit('engine.hostname.activate', row.hostname);
            expect(await fixture.store.recordDnsCheck(engine.engineId, row.hostname, check, entry)).toBe('updated');
            expect(await fixture.auditFor(engine.engineId)).toContainEqual(entry);
        });

        it('removes with its audit entry, and writes nothing for a row that is not there', async () => {
            const { engine: other } = await fixture.addEngine();
            const row = await inserted(name('a'));
            const foreign = audit('engine.hostname.remove', row.hostname, other);
            expect(await fixture.store.remove(other.engineId, row.hostname, foreign)).toBe('not-found');
            expect(await fixture.auditFor(other.engineId)).toEqual([]);
            const entry = audit('engine.hostname.remove', row.hostname);
            expect(await fixture.store.remove(engine.engineId, row.hostname, entry)).toBe('removed');
            expect(await fixture.store.listForEngine(engine.engineId)).toEqual([]);
            expect(await fixture.store.isAssigned(row.hostname)).toBe(false);
            expect(await fixture.auditFor(engine.engineId)).toContainEqual(entry);
            expect(
                await fixture.store.remove(
                    engine.engineId,
                    row.hostname,
                    audit('engine.hostname.remove', row.hostname),
                ),
            ).toBe('not-found');
            expect(await fixture.auditFor(engine.engineId)).toHaveLength(2);
        });
    });
}
