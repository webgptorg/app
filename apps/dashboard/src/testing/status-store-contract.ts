import { beforeEach, describe, expect, it } from 'vitest';

import type { UserRecord } from '../domain/auth/records';
import type { OrgId } from '../domain/ids';
import type { EngineRecord } from '../domain/registration/engine-store';
import type { AlertRecipients } from '../domain/status/alert-recipients';
import type { HeartbeatEngineReader } from '../domain/status/heartbeat-engine-reader';
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
}

const signal = new AbortController().signal;

/** One suite, run against the D1 and the in-memory heartbeat reads. */
export function describeStatusStoreContract(name: string, makeFixture: () => StatusStoreFixture): void {
    describe(`AlertRecipients and HeartbeatEngineReader contract: ${name}`, () => {
        let fixture: StatusStoreFixture;

        beforeEach(() => {
            fixture = makeFixture();
        });

        it('alerts the organization’s owners with a verified email, in their locale, and nobody else', async () => {
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
            expect(await fixture.recipients.forEngineOffline(org.orgId, signal)).toEqual([
                { email: coOwner.email, locale: 'en' },
                { email: org.user.email, locale: 'cs' },
            ]);
            expect(await fixture.recipients.forEngineOffline(other.orgId, signal)).toEqual([
                { email: other.user.email, locale: 'cs' },
            ]);
        });

        it('reads an engine’s organization, key and status, and nothing for an unknown engine', async () => {
            const account = testAccount();
            await fixture.addAccount(account);
            const active = await createTestEngine();
            const suspended = await createTestEngine();
            await fixture.addEngine(engineRecord(active, account.orgId));
            await fixture.addEngine(engineRecord(suspended, account.orgId, { status: 'suspended', statusReason: 'x' }));
            expect(await fixture.engines.findEngine(active.engineId)).toEqual({
                orgId: account.orgId,
                publicKey: active.publicKey,
                status: 'active',
            });
            expect(await fixture.engines.findEngine(suspended.engineId)).toMatchObject({ status: 'suspended' });
            expect(await fixture.engines.findEngine((await createTestEngine()).engineId)).toBeNull();
        });
    });
}
