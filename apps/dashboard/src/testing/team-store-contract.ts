import { OwnerSetupCommitment, type EngineId } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { cryptoRandom } from '../adapters/crypto-random';
import type { UserRecord } from '../domain/auth/records';
import { toBase64Url } from '../domain/auth/secrets';
import {
    newInviteId,
    newLinkCodeId,
    newOrgAuditEntryId,
    newTeamId,
    type OrgId,
    type TeamId,
    type UserId,
} from '../domain/ids';
import type { LinkCodeStore } from '../domain/registration/link-code-store';
import type { OrgRole } from '../domain/roles';
import type { InviteRecord, TeamAudit, TeamStore } from '../domain/teams/team-store';
import { teamNameSchema } from '../shared/team-name';
import { testAccount } from './auth-store-contract';
import { createTestEngine, engineRecord } from './test-engine';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

export interface TeamStoreFixture {
    readonly teams: TeamStore;
    readonly linkCodes: LinkCodeStore;
    /** A personal organization with its owner. */
    addAccount(account: ReturnType<typeof testAccount>): Promise<void>;
    addMember(orgId: OrgId, user: UserRecord, role: OrgRole): Promise<void>;
    /** `member_revocations` rows for the organization's engines, oldest first. */
    revocations(orgId: OrgId): Promise<readonly { readonly engineId: string; readonly userId: string }[]>;
    /** The organization's `org_audit_log` actions, oldest first. */
    auditActions(orgId: OrgId): Promise<readonly string[]>;
    /** A code's stored owner setup commitment (ADR 0023). */
    storedCommitment(codeHash: string): Promise<string | null>;
}

const name = (value: string) => teamNameSchema.parse(value);

function entry(actorUserId: UserId, at = NOW): TeamAudit {
    return { id: newOrgAuditEntryId(cryptoRandom), actorUserId, at };
}

/** One suite, run against the D1 and the in-memory team stores. */
export function describeTeamStoreContract(suite: string, makeFixture: () => TeamStoreFixture): void {
    describe(`TeamStore contract: ${suite}`, () => {
        let fixture: TeamStoreFixture;
        let owner: ReturnType<typeof testAccount>;
        let other: ReturnType<typeof testAccount>;
        let member: UserRecord;
        let tick = NOW;

        beforeEach(async () => {
            fixture = makeFixture();
            owner = testAccount(`b-${crypto.randomUUID()}@example.test`);
            other = testAccount();
            member = { ...testAccount(`a-${crypto.randomUUID()}@example.test`).user };
            await fixture.addAccount(owner);
            await fixture.addAccount(other);
            await fixture.addMember(owner.orgId, member, 'member');
        });

        async function team(label = 'Client A', orgId = owner.orgId, creator = owner.userId): Promise<TeamId> {
            const id = newTeamId(cryptoRandom);
            tick += 1;
            await fixture.teams.create({ id, orgId, name: name(label), createdAt: tick }, creator, entry(creator));
            return id;
        }

        /** Registers an engine through a link code, then binds it as registration does. */
        async function engineFor(teamId: TeamId | null, orgId = owner.orgId): Promise<EngineId> {
            const engine = await createTestEngine();
            const id = newLinkCodeId(cryptoRandom);
            const codeHash = toBase64Url(cryptoRandom.bytes(32));
            await fixture.linkCodes.insert({
                id,
                codeHash,
                orgId,
                createdByUserId: owner.userId,
                createdAt: NOW,
                expiresAt: NOW + DAY,
                ownerSetupCommitment: null,
            });
            if (teamId !== null) {
                expect(await fixture.teams.attachLinkCode(orgId, id, teamId, NOW)).toBe('attached');
            }
            expect(await fixture.linkCodes.redeemForNewEngine(codeHash, engineRecord(engine, orgId), null)).toBe(
                'redeemed',
            );
            await fixture.teams.bindNewEngine(engine.engineId, {
                teamId: newTeamId(cryptoRandom),
                name: name('engine.example.test'),
                at: (tick += 1),
            });
            return engine.engineId;
        }

        function invite(overrides: Partial<InviteRecord> = {}): InviteRecord {
            return {
                id: newInviteId(cryptoRandom),
                tokenHash: toBase64Url(cryptoRandom.bytes(32)),
                orgId: owner.orgId,
                email: 'new@example.test',
                role: 'member',
                teamIds: [],
                invitedByUserId: owner.userId,
                createdAt: NOW,
                expiresAt: NOW + 7 * DAY,
                ...overrides,
            };
        }

        it('creates teams with their creator, lists them per organization and per member, and renames them', async () => {
            const a = await team('Client A');
            const b = await team('Client B');
            await team('Elsewhere', other.orgId, other.userId);
            expect((await fixture.teams.list(owner.orgId)).map((t) => [t.name, t.memberCount, t.engineId])).toEqual([
                ['Client A', 1, null],
                ['Client B', 1, null],
            ]);
            expect(await fixture.teams.find(other.orgId, a)).toBeNull();
            expect(await fixture.teams.addMember(owner.orgId, b, member.id, entry(owner.userId))).toBe('added');
            expect((await fixture.teams.listForUser(owner.orgId, member.id)).map((t) => t.id)).toEqual([b]);
            expect(await fixture.teams.isMember(owner.orgId, b, member.id)).toBe(true);
            expect(await fixture.teams.isMember(owner.orgId, a, member.id)).toBe(false);
            expect(await fixture.teams.rename(owner.orgId, a, name('Client A2'), entry(owner.userId))).toBe('renamed');
            expect((await fixture.teams.find(owner.orgId, a))?.name).toBe('Client A2');
            expect(await fixture.teams.rename(other.orgId, a, name('Nope'), entry(other.userId))).toBe('not-found');
            expect(await fixture.auditActions(owner.orgId)).toEqual([
                'team.create',
                'team.create',
                'team.member.add',
                'team.rename',
            ]);
        });

        it('adds only people of the organization, once, and lists them with their org role', async () => {
            const a = await team();
            expect(await fixture.teams.addMember(owner.orgId, a, member.id, entry(owner.userId))).toBe('added');
            expect(await fixture.teams.addMember(owner.orgId, a, member.id, entry(owner.userId))).toBe('already');
            expect(await fixture.teams.addMember(owner.orgId, a, other.userId, entry(owner.userId))).toBe('not-member');
            expect(await fixture.teams.addMember(other.orgId, a, other.userId, entry(other.userId))).toBe('not-found');
            expect(
                (await fixture.teams.listMembers(owner.orgId, a)).map((person) => [person.email, person.role]),
            ).toEqual([
                [member.email, 'member'],
                [owner.user.email, 'owner'],
            ]);
            expect(await fixture.teams.listMembers(other.orgId, a)).toEqual([]);
        });

        it('binds a new engine to the team its link code named, or else to a team of its own with the code’s creator', async () => {
            const a = await team();
            await fixture.teams.addMember(owner.orgId, a, member.id, entry(owner.userId));
            const named = await engineFor(a);
            const own = await engineFor(null);
            expect((await fixture.teams.find(owner.orgId, a))?.engineId).toBe(named);
            const teams = await fixture.teams.list(owner.orgId);
            expect(teams.map((t) => [t.name, t.engineId, t.memberCount])).toEqual([
                ['Client A', named, 2],
                ['engine.example.test', own, 1],
            ]);
            expect([...(await fixture.teams.engineIdsForUser(owner.orgId, member.id))]).toEqual([named]);
            expect((await fixture.teams.engineIdsForUser(owner.orgId, owner.userId)).size).toBe(2);
            await fixture.teams.bindNewEngine(named, { teamId: newTeamId(cryptoRandom), name: name('Again'), at: NOW });
            expect(await fixture.teams.list(owner.orgId)).toHaveLength(2);
        });

        it('attaches a link code only to a team of the organization without an engine', async () => {
            const a = await team();
            await engineFor(a);
            const empty = await team('Empty');
            const code = { id: newLinkCodeId(cryptoRandom), codeHash: toBase64Url(cryptoRandom.bytes(32)) };
            await fixture.linkCodes.insert({
                ...code,
                orgId: owner.orgId,
                createdByUserId: owner.userId,
                createdAt: NOW,
                expiresAt: NOW + DAY,
                ownerSetupCommitment: null,
            });
            expect(await fixture.teams.attachLinkCode(owner.orgId, code.id, a, NOW)).toBe('not-found');
            expect(await fixture.teams.attachLinkCode(other.orgId, code.id, empty, NOW)).toBe('not-found');
            expect(await fixture.teams.attachLinkCode(owner.orgId, newLinkCodeId(cryptoRandom), empty, NOW)).toBe(
                'not-found',
            );
            expect(await fixture.teams.attachLinkCode(owner.orgId, code.id, empty, NOW)).toBe('attached');
        });

        it('ends the team’s earlier pending code when a new one is attached, and no other team’s', async () => {
            const a = await team();
            const b = await team('Other');
            async function code(teamId: TeamId) {
                const id = newLinkCodeId(cryptoRandom);
                const codeHash = toBase64Url(cryptoRandom.bytes(32));
                await fixture.linkCodes.insert({
                    id,
                    codeHash,
                    orgId: owner.orgId,
                    createdByUserId: owner.userId,
                    createdAt: NOW,
                    expiresAt: NOW + DAY,
                    ownerSetupCommitment: OwnerSetupCommitment.parse(toBase64Url(cryptoRandom.bytes(32))),
                });
                expect(await fixture.teams.attachLinkCode(owner.orgId, id, teamId, NOW + 1)).toBe('attached');
                return { id, codeHash };
            }
            const first = await code(a);
            const elsewhere = await code(b);
            const second = await code(a);
            expect(await fixture.linkCodes.findState(owner.orgId, first.id, NOW + 1)).toEqual({ kind: 'expired' });
            expect(await fixture.linkCodes.findRedeemable(first.codeHash, NOW + 1)).toBeNull();
            expect(await fixture.storedCommitment(first.codeHash)).toBeNull();
            expect(await fixture.storedCommitment(second.codeHash)).not.toBeNull();
            for (const kept of [second, elsewhere]) {
                expect((await fixture.linkCodes.findRedeemable(kept.codeHash, NOW + 1))?.orgId).toBe(owner.orgId);
            }
        });

        it('queues a revocation for the team’s engine when someone leaves it, and none for a team without one', async () => {
            const a = await team();
            const b = await team('No engine');
            const engineId = await engineFor(a);
            await fixture.teams.addMember(owner.orgId, a, member.id, entry(owner.userId));
            await fixture.teams.addMember(owner.orgId, b, member.id, entry(owner.userId));
            expect(await fixture.teams.removeMember(owner.orgId, b, member.id, entry(owner.userId))).toBe('removed');
            expect(await fixture.revocations(owner.orgId)).toEqual([]);
            expect(await fixture.teams.removeMember(owner.orgId, a, member.id, entry(owner.userId))).toBe('removed');
            expect(await fixture.teams.removeMember(owner.orgId, a, member.id, entry(owner.userId))).toBe('not-found');
            expect(await fixture.revocations(owner.orgId)).toEqual([{ engineId, userId: member.id }]);
        });

        it('deletes a team: it disappears, its people leave and its engine hears of each', async () => {
            const a = await team();
            const engineId = await engineFor(a);
            await fixture.teams.addMember(owner.orgId, a, member.id, entry(owner.userId));
            expect(await fixture.teams.delete(owner.orgId, a, entry(owner.userId))).toBe('deleted');
            expect(await fixture.teams.find(owner.orgId, a)).toBeNull();
            expect(await fixture.teams.list(owner.orgId)).toEqual([]);
            expect(await fixture.teams.delete(owner.orgId, a, entry(owner.userId))).toBe('not-found');
            expect((await fixture.revocations(owner.orgId)).map((r) => r.engineId)).toEqual([engineId, engineId]);
            expect(await fixture.teams.engineIdsForUser(owner.orgId, member.id)).toEqual(new Set());
        });

        it('changes roles but never leaves the organization without an owner', async () => {
            expect(await fixture.teams.changeRole(owner.orgId, member.id, 'admin', entry(owner.userId))).toBe(
                'changed',
            );
            expect(await fixture.teams.changeRole(owner.orgId, member.id, 'admin', entry(owner.userId))).toBe(
                'unchanged',
            );
            expect(await fixture.teams.changeRole(owner.orgId, owner.userId, 'admin', entry(owner.userId))).toBe(
                'last-owner',
            );
            expect(await fixture.teams.changeRole(owner.orgId, other.userId, 'admin', entry(owner.userId))).toBe(
                'not-found',
            );
            expect(await fixture.teams.changeRole(owner.orgId, member.id, 'owner', entry(owner.userId))).toBe(
                'changed',
            );
            expect(await fixture.teams.changeRole(owner.orgId, owner.userId, 'member', entry(owner.userId))).toBe(
                'changed',
            );
            expect(
                (await fixture.teams.listOrgMembers(owner.orgId)).map((person) => [person.email, person.role]),
            ).toEqual([
                [member.email, 'owner'],
                [owner.user.email, 'member'],
            ]);
            expect(await fixture.auditActions(owner.orgId)).toEqual([
                'org.member.role',
                'org.member.role',
                'org.member.role',
            ]);
        });

        it('removes someone from the organization and all its teams, with revocations, but not its last owner', async () => {
            const a = await team();
            const engineId = await engineFor(a);
            await fixture.teams.addMember(owner.orgId, a, member.id, entry(owner.userId));
            expect(
                (await fixture.teams.listOrgMembers(owner.orgId)).find((p) => p.userId === member.id)?.teamIds,
            ).toEqual([a]);
            expect(await fixture.teams.removeFromOrg(owner.orgId, owner.userId, entry(owner.userId))).toBe(
                'last-owner',
            );
            expect(await fixture.teams.removeFromOrg(owner.orgId, member.id, entry(owner.userId))).toBe('removed');
            expect(await fixture.teams.removeFromOrg(owner.orgId, member.id, entry(owner.userId))).toBe('not-found');
            expect(await fixture.teams.isMember(owner.orgId, a, member.id)).toBe(false);
            expect((await fixture.teams.listOrgMembers(owner.orgId)).map((p) => p.userId)).toEqual([owner.userId]);
            expect(await fixture.revocations(owner.orgId)).toEqual([{ engineId, userId: member.id }]);
        });

        it('keeps invitations pending until accepted, revoked, renewed or expired', async () => {
            const a = await team();
            const pending = invite({ teamIds: [a] });
            const expired = invite({ expiresAt: NOW });
            await fixture.teams.insertInvite(pending, entry(owner.userId));
            await fixture.teams.insertInvite(expired, entry(owner.userId));
            await expect(
                fixture.teams.insertInvite(invite({ tokenHash: pending.tokenHash }), entry(owner.userId)),
            ).rejects.toThrow();
            expect((await fixture.teams.listPendingInvites(owner.orgId, NOW)).map((i) => i.id)).toEqual([pending.id]);
            expect(await fixture.teams.previewInvite(pending.tokenHash, NOW)).toEqual({
                invite: pending,
                orgName: null,
                teamNames: ['Client A'],
            });
            expect(await fixture.teams.previewInvite(expired.tokenHash, NOW)).toBeNull();

            const renewed = await fixture.teams.renewInvite(
                owner.orgId,
                pending.id,
                { tokenHash: 'renewed-hash', expiresAt: NOW + 8 * DAY, now: NOW },
                entry(owner.userId),
            );
            expect(renewed).toEqual({ ...pending, tokenHash: 'renewed-hash', expiresAt: NOW + 8 * DAY });
            expect(await fixture.teams.previewInvite(pending.tokenHash, NOW)).toBeNull();
            expect(
                await fixture.teams.renewInvite(
                    other.orgId,
                    pending.id,
                    { tokenHash: 'x', expiresAt: NOW, now: NOW },
                    entry(other.userId),
                ),
            ).toBeNull();

            expect(await fixture.teams.revokeInvite(other.orgId, pending.id, entry(other.userId))).toBe('not-found');
            expect(await fixture.teams.revokeInvite(owner.orgId, pending.id, entry(owner.userId))).toBe('revoked');
            expect(await fixture.teams.revokeInvite(owner.orgId, pending.id, entry(owner.userId))).toBe('not-found');
            expect(await fixture.teams.listPendingInvites(owner.orgId, NOW)).toEqual([]);
            expect(
                await fixture.teams.acceptInvite('renewed-hash', member.id, { id: entry(member.id).id, at: NOW }),
            ).toEqual({
                kind: 'invalid',
            });
        });

        it('lists the pending invitations to one address across organizations, newest first, with who sent them', async () => {
            const a = await team();
            const email = `invited-${crypto.randomUUID()}@example.test`;
            const older = invite({ email, teamIds: [a] });
            const newer = invite({ email, orgId: other.orgId, invitedByUserId: other.userId, createdAt: NOW + 1 });
            const revoked = invite({ email });
            const used = invite({ email });
            for (const record of [older, newer, revoked, used, invite({ email, expiresAt: NOW }), invite()]) {
                await fixture.teams.insertInvite(record, entry(record.invitedByUserId));
            }
            await fixture.teams.revokeInvite(owner.orgId, revoked.id, entry(owner.userId));
            await fixture.teams.acceptInvite(used.tokenHash, member.id, { id: entry(member.id).id, at: NOW });

            expect(await fixture.teams.listInvitesForEmail(email, NOW)).toEqual([
                { invite: newer, orgName: null, teamNames: [], inviterEmail: other.user.email },
                { invite: older, orgName: null, teamNames: ['Client A'], inviterEmail: owner.user.email },
            ]);
            expect(await fixture.teams.listInvitesForEmail(email, NOW + 7 * DAY)).toEqual([]);
            expect(await fixture.teams.listInvitesForEmail('nobody@example.test', NOW)).toEqual([]);
        });

        it('accepts an invitation once: membership with its role, the teams that still exist, no second use', async () => {
            const a = await team();
            const gone = await team('Gone');
            const newcomer = testAccount();
            await fixture.addAccount(newcomer);
            const pending = invite({ teamIds: [a, gone], role: 'admin', email: newcomer.user.email });
            await fixture.teams.insertInvite(pending, entry(owner.userId));
            await fixture.teams.delete(owner.orgId, gone, entry(owner.userId));
            expect(
                await fixture.teams.acceptInvite(pending.tokenHash, newcomer.userId, {
                    id: entry(newcomer.userId).id,
                    at: NOW + 1,
                }),
            ).toEqual({
                kind: 'accepted',
                orgId: owner.orgId,
            });
            expect(
                await fixture.teams.acceptInvite(pending.tokenHash, newcomer.userId, {
                    id: entry(newcomer.userId).id,
                    at: NOW + 2,
                }),
            ).toEqual({
                kind: 'invalid',
            });
            const people = await fixture.teams.listOrgMembers(owner.orgId);
            expect(people.find((p) => p.userId === newcomer.userId)).toMatchObject({ role: 'admin', teamIds: [a] });

            // Someone already in the organization keeps their role and only gains the teams.
            const again = invite({ teamIds: [a], role: 'owner' });
            await fixture.teams.insertInvite(again, entry(owner.userId));
            await fixture.teams.acceptInvite(again.tokenHash, member.id, { id: entry(member.id).id, at: NOW + 3 });
            expect((await fixture.teams.listOrgMembers(owner.orgId)).find((p) => p.userId === member.id)).toMatchObject(
                {
                    role: 'member',
                    teamIds: [a],
                },
            );
            expect(
                (await fixture.auditActions(owner.orgId)).filter((action) => action === 'invite.accept'),
            ).toHaveLength(2);
        });

        async function ticket(teamId: TeamId, engineId: EngineId, userId: UserId, issuedAt = NOW): Promise<string> {
            const id = toBase64Url(cryptoRandom.bytes(32));
            await fixture.teams.recordTicket({
                id,
                teamId,
                engineId,
                userId,
                issuedAt,
                expiresAt: issuedAt + 15 * 60_000,
            });
            return id;
        }

        async function accessOf(teamId: TeamId, userId: UserId) {
            return (await fixture.teams.listMembers(owner.orgId, teamId)).find((person) => person.userId === userId)
                ?.access;
        }

        it('follows a member’s access through tickets and the engine’s acks', async () => {
            const a = await team();
            const engineId = await engineFor(a);
            await fixture.teams.addMember(owner.orgId, a, member.id, entry(owner.userId));
            expect(await accessOf(a, member.id)).toBe('none');

            const declined = await ticket(a, engineId, member.id);
            expect(await accessOf(a, member.id)).toBe('waiting');
            expect(await fixture.teams.applyTicketAck(engineId, declined, 'declined', NOW + 1)).toMatchObject({
                teamId: a,
                userId: member.id,
                email: member.email,
            });
            expect(await accessOf(a, member.id)).toBe('none');
            expect(await fixture.teams.applyTicketAck(engineId, declined, 'approved', NOW + 2)).toBeNull();

            const approved = await ticket(a, engineId, member.id);
            const otherEngine = await createTestEngine();
            expect(await fixture.teams.applyTicketAck(otherEngine.engineId, approved, 'approved', NOW + 3)).toBeNull();
            expect(await fixture.teams.applyTicketAck(engineId, 'never-issued-ticket', 'approved', NOW + 3)).toBeNull();
            expect(await fixture.teams.applyTicketAck(engineId, approved, 'approved', NOW + 3)).toMatchObject({
                teamName: 'Client A',
                locale: 'cs',
            });
            expect(await accessOf(a, member.id)).toBe('approved');
            await ticket(a, engineId, member.id);
            expect(await accessOf(a, member.id)).toBe('approved');

            expect(await fixture.teams.applyTicketAck(engineId, approved, 'removed', NOW + 4)).not.toBeNull();
            expect(await fixture.teams.isMember(owner.orgId, a, member.id)).toBe(false);
            expect(await fixture.teams.applyTicketAck(engineId, approved, 'removed', NOW + 5)).toBeNull();
            expect(await fixture.revocations(owner.orgId)).toEqual([]);
        });

        it('tells the inviter and the team’s owners and admins of a waiting request, once', async () => {
            const a = await team();
            const engineId = await engineFor(a);
            const admin = testAccount(`c-admin-${crypto.randomUUID()}@example.test`).user;
            const outsideAdmin = testAccount().user;
            await fixture.addMember(owner.orgId, admin, 'admin');
            await fixture.addMember(owner.orgId, outsideAdmin, 'admin');
            await fixture.teams.addMember(owner.orgId, a, admin.id, entry(owner.userId));
            const newcomer = testAccount();
            await fixture.addAccount(newcomer);
            const invited = invite({ email: newcomer.user.email, teamIds: [a], invitedByUserId: outsideAdmin.id });
            await fixture.teams.insertInvite(invited, entry(outsideAdmin.id));
            await fixture.teams.acceptInvite(invited.tokenHash, newcomer.userId, {
                id: entry(newcomer.userId).id,
                at: NOW,
            });

            const old = await ticket(a, engineId, newcomer.userId, NOW - 10);
            const fresh = await ticket(a, engineId, newcomer.userId, NOW + 10);
            const notices = await fixture.teams.ticketsAwaitingNotice(engineId, NOW);
            expect(notices.map((notice) => notice.ticketId)).toEqual([fresh]);
            expect(notices[0]).toMatchObject({ teamId: a, teamName: 'Client A', requesterEmail: newcomer.user.email });
            expect(notices[0]?.recipients.map((recipient) => recipient.email).sort()).toEqual(
                [owner.user.email, admin.email, outsideAdmin.email].sort(),
            );
            await fixture.teams.markNoticed([fresh], NOW + 20);
            await fixture.teams.markNoticed([], NOW + 20);
            expect(await fixture.teams.ticketsAwaitingNotice(engineId, NOW)).toEqual([]);
            expect((await fixture.teams.ticketsAwaitingNotice(engineId, NOW - 100)).map((n) => n.ticketId)).toEqual([
                old,
            ]);
        });

        it('hands out pending revocations oldest first, closes acked ones, and shows who is still being removed', async () => {
            const a = await team();
            const engineId = await engineFor(a);
            const second = testAccount().user;
            await fixture.addMember(owner.orgId, second, 'member');
            await fixture.teams.addMember(owner.orgId, a, member.id, entry(owner.userId));
            await fixture.teams.addMember(owner.orgId, a, second.id, entry(owner.userId));
            await fixture.teams.removeMember(owner.orgId, a, member.id, entry(owner.userId, NOW + 1));
            await fixture.teams.removeMember(owner.orgId, a, second.id, entry(owner.userId, NOW + 2));
            const pending = await fixture.teams.pendingRevocations(engineId, 32);
            expect(pending.map((revocation) => revocation.userId)).toEqual([member.id, second.id]);
            expect(await fixture.teams.pendingRevocations(engineId, 1)).toHaveLength(1);
            expect(pending[0]?.id).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
            expect((await fixture.teams.listRemoving(owner.orgId, a)).map((person) => person.userId).sort()).toEqual(
                [member.id, second.id].sort(),
            );

            const otherEngine = await createTestEngine();
            await fixture.teams.closeRevocation(otherEngine.engineId, pending[0]?.id ?? '', 'revoked', NOW + 3);
            expect(await fixture.teams.pendingRevocations(engineId, 32)).toHaveLength(2);
            await fixture.teams.closeRevocation(engineId, pending[0]?.id ?? '', 'revoked', NOW + 3);
            expect((await fixture.teams.pendingRevocations(engineId, 32)).map((r) => r.userId)).toEqual([second.id]);
            expect((await fixture.teams.listRemoving(owner.orgId, a)).map((person) => person.userId)).toEqual([
                second.id,
            ]);

            // Back in the team, they are a member again, not someone being removed.
            await fixture.teams.addMember(owner.orgId, a, second.id, entry(owner.userId));
            expect(await fixture.teams.listRemoving(owner.orgId, a)).toEqual([]);
            expect(await fixture.teams.listRemoving(other.orgId, a)).toEqual([]);
        });

        it('lists a person whose removal the engine refused until a later removal or the engine settles it', async () => {
            const a = await team();
            const engineId = await engineFor(a);
            await fixture.teams.addMember(owner.orgId, a, member.id, entry(owner.userId));
            await fixture.teams.removeMember(owner.orgId, a, member.id, entry(owner.userId, NOW + 1));
            expect(await fixture.teams.listRefused(owner.orgId, a)).toEqual([]);

            const [first] = await fixture.teams.pendingRevocations(engineId, 1);
            await fixture.teams.closeRevocation(engineId, first?.id ?? '', 'refused-disabled', NOW + 2);
            expect(await fixture.teams.listRemoving(owner.orgId, a)).toEqual([]);
            expect(await fixture.teams.listRefused(owner.orgId, a)).toMatchObject([
                { userId: member.id, outcome: 'refused-disabled' },
            ]);
            expect(await fixture.teams.listRefused(other.orgId, a)).toEqual([]);

            // Back in the team and removed again: the new removal is what counts, and the engine accepts it.
            await fixture.teams.addMember(owner.orgId, a, member.id, entry(owner.userId, NOW + 3));
            expect(await fixture.teams.listRefused(owner.orgId, a)).toEqual([]);
            await fixture.teams.removeMember(owner.orgId, a, member.id, entry(owner.userId, NOW + 4));
            expect(await fixture.teams.listRefused(owner.orgId, a)).toEqual([]);
            const [second] = await fixture.teams.pendingRevocations(engineId, 1);
            await fixture.teams.closeRevocation(engineId, second?.id ?? '', 'revoked', NOW + 5);
            expect(await fixture.teams.listRefused(owner.orgId, a)).toEqual([]);
        });

        it('stops listing a refused person once they are removed on the engine itself', async () => {
            const a = await team();
            const engineId = await engineFor(a);
            await fixture.teams.addMember(owner.orgId, a, member.id, entry(owner.userId));
            const issued = await ticket(a, engineId, member.id);
            await fixture.teams.applyTicketAck(engineId, issued, 'approved', NOW + 1);
            await fixture.teams.removeMember(owner.orgId, a, member.id, entry(owner.userId, NOW + 2));
            const [revocation] = await fixture.teams.pendingRevocations(engineId, 1);
            await fixture.teams.closeRevocation(engineId, revocation?.id ?? '', 'refused-disabled', NOW + 3);
            expect(await fixture.teams.listRefused(owner.orgId, a)).toMatchObject([{ userId: member.id }]);

            await fixture.teams.applyTicketAck(engineId, issued, 'removed', NOW + 4);
            expect(await fixture.teams.listRefused(owner.orgId, a)).toEqual([]);
        });
    });
}
