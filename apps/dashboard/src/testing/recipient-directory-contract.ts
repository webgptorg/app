import type { EngineId } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import type { UserRecord } from '../domain/auth/records';
import type { OrgId, UserId } from '../domain/ids';
import type { RecipientDirectory } from '../domain/notifications/recipient-directory';
import type { EngineRecord } from '../domain/registration/engine-store';
import type { HeartbeatEngineReader } from '../domain/status/heartbeat-engine-reader';
import type { MemberAccess } from '../domain/teams/team-store';
import { engineLabelSchema } from '../shared/engine-label';
import { testAccount } from './auth-store-contract';
import { createTestEngine, engineRecord } from './test-engine';

export interface RecipientDirectoryFixture {
    readonly directory: RecipientDirectory;
    readonly engines: HeartbeatEngineReader;
    /** A personal organization with a verified Czech owner. */
    addAccount(account: ReturnType<typeof testAccount>): Promise<void>;
    /** A user in `orgId` with a role the closed union may not know yet, as a later team role would be stored. */
    addMember(orgId: OrgId, user: UserRecord, role: string): Promise<void>;
    addEngine(engine: EngineRecord): Promise<void>;
    /** A team named `name` holding the engine and these people, with their access. */
    addTeam(
        orgId: OrgId,
        engineId: EngineId,
        name: string,
        people: readonly (readonly [UserId, MemberAccess])[],
    ): Promise<void>;
    /** A link code `userId` made and the engine redeemed: who linked the project. */
    addLinker(orgId: OrgId, engineId: EngineId, userId: UserId): Promise<void>;
    /** An unanswered access ticket for `userId` to the engine, noticed or not, issued at `issuedAt`. */
    addTicket(
        engineId: EngineId,
        userId: UserId,
        ticket: { readonly noticed: boolean; readonly issuedAt: number },
    ): Promise<void>;
}

const signal = new AbortController().signal;

/** One suite, run against the D1 and the in-memory directories: ADR 0027's "Mapping counts to people". */
export function describeRecipientDirectoryContract(name: string, makeFixture: () => RecipientDirectoryFixture): void {
    describe(`RecipientDirectory and HeartbeatEngineReader contract: ${name}`, () => {
        let fixture: RecipientDirectoryFixture;
        let org: ReturnType<typeof testAccount>;
        let admin: UserRecord;
        let approvedMember: UserRecord;
        let waitingMember: UserRecord;
        let outsider: UserRecord;
        let linker: UserRecord;
        let engine: EngineRecord;

        beforeEach(async () => {
            fixture = makeFixture();
            org = testAccount(`a-owner-${crypto.randomUUID()}@example.test`);
            await fixture.addAccount(org);
            admin = { ...testAccount(`b-admin-${crypto.randomUUID()}@example.test`).user, locale: 'en' };
            approvedMember = testAccount(`c-member-${crypto.randomUUID()}@example.test`).user;
            waitingMember = {
                ...testAccount(`d-member-${crypto.randomUUID()}@example.test`).user,
                emailVerifiedAt: null,
            };
            outsider = testAccount(`e-member-${crypto.randomUUID()}@example.test`).user;
            linker = testAccount(`f-admin-${crypto.randomUUID()}@example.test`).user;
            await fixture.addMember(org.orgId, admin, 'admin');
            await fixture.addMember(org.orgId, approvedMember, 'member');
            await fixture.addMember(org.orgId, waitingMember, 'member');
            await fixture.addMember(org.orgId, outsider, 'member');
            await fixture.addMember(org.orgId, linker, 'admin');
            engine = engineRecord(await createTestEngine(), org.orgId);
            await fixture.addEngine(engine);
            await fixture.addTeam(org.orgId, engine.engineId, 'Marketing site', [
                [admin.id, 'approved'],
                [approvedMember.id, 'approved'],
                [waitingMember.id, 'waiting'],
            ]);
            await fixture.addLinker(org.orgId, engine.engineId, linker.id);
        });

        const ids = (people: readonly { readonly userId: string }[]) => people.map((person) => person.userId).sort();

        it('names everyone who sees the project with their role, and nobody else but the org managers', async () => {
            const viewers = await fixture.directory.resolve(
                org.orgId,
                engine.engineId,
                { kind: 'project-viewers' },
                signal,
            );
            expect(ids(viewers)).toEqual(ids([org, ...[admin, approvedMember, waitingMember, linker].map(asUser)]));
            expect(viewers.find((person) => person.userId === admin.id)).toEqual({
                userId: admin.id,
                email: admin.email,
                emailVerified: true,
                locale: 'en',
                role: 'org-admin',
                manager: true,
                approved: true,
            });
            expect(viewers.find((person) => person.userId === waitingMember.id)).toMatchObject({
                role: 'member',
                emailVerified: false,
                manager: false,
                approved: false,
            });
        });

        it('makes managers of who linked it and the org managers with approved access, never members', async () => {
            const managers = await fixture.directory.resolve(
                org.orgId,
                engine.engineId,
                { kind: 'project-managers' },
                signal,
            );
            // The owner is not in the team, so the engine never approved them; the linker manages it regardless.
            expect(ids(managers)).toEqual(ids([admin, linker].map(asUser)));
        });

        it('names org managers and single people, and only people who still see the project', async () => {
            const managers = await fixture.directory.resolve(org.orgId, null, { kind: 'org-managers' }, signal);
            expect(ids(managers)).toEqual(ids([org, ...[admin, linker].map(asUser)]));
            const person = { kind: 'person', userId: outsider.id } as const;
            expect(await fixture.directory.resolve(org.orgId, engine.engineId, person, signal)).toEqual([]);
            expect(ids(await fixture.directory.resolve(org.orgId, null, person, signal))).toEqual([outsider.id]);
            expect(await fixture.directory.member(org.orgId, engine.engineId, outsider.id, signal)).toBeNull();
            expect(await fixture.directory.member(org.orgId, engine.engineId, approvedMember.id, signal)).toMatchObject(
                {
                    approved: true,
                    manager: false,
                },
            );
        });

        it('knows nothing of another organization’s project, nor of a role the closed union lacks', async () => {
            const other = testAccount();
            await fixture.addAccount(other);
            const viewers = { kind: 'project-viewers' } as const;
            expect(await fixture.directory.resolve(other.orgId, engine.engineId, viewers, signal)).toEqual([]);
            expect(await fixture.directory.place(other.orgId, engine.engineId, signal)).toBeNull();
            expect(await fixture.directory.member(other.orgId, engine.engineId, other.userId, signal)).toBeNull();
            const viewer = testAccount().user;
            await fixture.addMember(org.orgId, viewer, 'viewer');
            expect(ids(await fixture.directory.resolve(org.orgId, null, viewers, signal))).not.toContain(viewer.id);
        });

        it('places a project by its label, else its team’s name, and says whether it is active', async () => {
            expect(await fixture.directory.place(org.orgId, engine.engineId, signal)).toEqual({
                orgName: null,
                project: { label: 'Marketing site', hostname: engine.hostname, active: true },
            });
            const labelled = engineRecord(await createTestEngine(), org.orgId, {
                label: engineLabelSchema.parse('Sales bot'),
                status: 'suspended',
                statusReason: 'x',
            });
            await fixture.addEngine(labelled);
            expect(await fixture.directory.place(org.orgId, labelled.engineId, signal)).toEqual({
                orgName: null,
                project: { label: 'Sales bot', hostname: labelled.hostname, active: false },
            });
            expect(await fixture.directory.place(org.orgId, null, signal)).toEqual({ orgName: null, project: null });
        });

        it('lists who still waits for approval, from noticed tickets only', async () => {
            await fixture.addTicket(engine.engineId, waitingMember.id, { noticed: true, issuedAt: 2000 });
            await fixture.addTicket(engine.engineId, outsider.id, { noticed: false, issuedAt: 2000 });
            await fixture.addTicket(engine.engineId, approvedMember.id, { noticed: true, issuedAt: 500 });
            expect(await fixture.directory.waitingRequesters(engine.engineId, 1000, signal)).toEqual([
                waitingMember.email,
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

function asUser(user: UserRecord): { readonly userId: string } {
    return { userId: user.id };
}
