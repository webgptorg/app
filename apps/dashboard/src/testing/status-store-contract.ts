import { beforeEach, describe, expect, it } from 'vitest';

import type { UserRecord } from '../domain/auth/records';
import type { EngineId } from '@ptbk/protocol';

import type { OrgId, UserId } from '../domain/ids';
import type { EngineRecord } from '../domain/registration/engine-store';
import type { AlertRecipients } from '../domain/status/alert-recipients';
import type { HeartbeatEngineReader } from '../domain/status/heartbeat-engine-reader';
import { engineLabelSchema } from '../shared/engine-label';
import { testAccount } from './auth-store-contract';
import { createTestEngine, engineRecord } from './test-engine';

export interface StatusStoreFixture {
    readonly recipients: AlertRecipients;
    readonly engines: HeartbeatEngineReader;
    /** A personal organization with a verified Czech owner. */
    addAccount(account: ReturnType<typeof testAccount>): Promise<void>;
    /** A user in `orgId` with a role the closed union may not know yet, as a later team role would be stored. */
    addMember(orgId: OrgId, user: UserRecord, role: string): Promise<void>;
    addEngine(engine: EngineRecord): Promise<void>;
    /** A team holding the engine and these people. */
    addTeam(orgId: OrgId, engineId: EngineId, userIds: readonly UserId[]): Promise<void>;
}

const signal = new AbortController().signal;

/** One suite, run against the D1 and the in-memory heartbeat reads. */
export function describeStatusStoreContract(name: string, makeFixture: () => StatusStoreFixture): void {
    describe(`AlertRecipients and HeartbeatEngineReader contract: ${name}`, () => {
        let fixture: StatusStoreFixture;

        beforeEach(() => {
            fixture = makeFixture();
        });

        it('alerts the organization’s owners with a verified email, in their locale, when none is in the engine’s team', async () => {
            const engineId = (await createTestEngine()).engineId;
            const org = testAccount(`b-owner-${crypto.randomUUID()}@example.test`);
            const other = testAccount();
            await fixture.addAccount(org);
            await fixture.addAccount(other);
            const coOwner = {
                ...testAccount(`a-owner-${crypto.randomUUID()}@example.test`).user,
                locale: 'en' as const,
            };
            const unverified = { ...testAccount().user, emailVerifiedAt: null };
            const viewer = testAccount().user;
            await fixture.addMember(org.orgId, coOwner, 'owner');
            await fixture.addMember(org.orgId, unverified, 'owner');
            await fixture.addMember(org.orgId, viewer, 'viewer');
            expect(await fixture.recipients.forEngineStatus(org.orgId, engineId, signal)).toEqual([
                { email: coOwner.email, locale: 'en' },
                { email: org.user.email, locale: 'cs' },
            ]);
            expect(await fixture.recipients.forEngineStatus(other.orgId, engineId, signal)).toEqual([
                { email: other.user.email, locale: 'cs' },
            ]);
        });

        it('alerts the owners and admins in the engine’s team, not team members or owners outside it', async () => {
            const org = testAccount();
            await fixture.addAccount(org);
            const admin = testAccount(`a-admin-${crypto.randomUUID()}@example.test`).user;
            const member = testAccount().user;
            await fixture.addMember(org.orgId, admin, 'admin');
            await fixture.addMember(org.orgId, member, 'member');
            const engine = await createTestEngine();
            await fixture.addEngine(engineRecord(engine, org.orgId));
            await fixture.addTeam(org.orgId, engine.engineId, [admin.id, member.id]);
            expect(await fixture.recipients.forEngineStatus(org.orgId, engine.engineId, signal)).toEqual([
                { email: admin.email, locale: 'cs' },
            ]);
        });

        it('reads an engine’s organization, key, status and label, and nothing for an unknown engine', async () => {
            const account = testAccount();
            await fixture.addAccount(account);
            const active = await createTestEngine();
            const suspended = await createTestEngine();
            await fixture.addEngine(engineRecord(active, account.orgId));
            await fixture.addEngine(
                engineRecord(suspended, account.orgId, {
                    status: 'suspended',
                    statusReason: 'x',
                    label: engineLabelSchema.parse('Old box'),
                }),
            );
            expect(await fixture.engines.findEngine(active.engineId)).toEqual({
                orgId: account.orgId,
                publicKey: active.publicKey,
                status: 'active',
                label: null,
            });
            expect(await fixture.engines.findEngine(suspended.engineId)).toMatchObject({
                status: 'suspended',
                label: 'Old box',
            });
            expect(await fixture.engines.findEngine((await createTestEngine()).engineId)).toBeNull();
        });
    });
}
