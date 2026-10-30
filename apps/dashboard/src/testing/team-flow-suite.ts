import {
    ed25519PublicKeyToBytes,
    heartbeatPath,
    HeartbeatReply,
    LinkCode,
    REGISTER_PATH,
    Timestamp,
    verifyAccessTicket,
    verifyMemberRevocation,
    type EngineId,
} from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import type {
    EngineView,
    LinkCodeView,
    OrgMemberView,
    PersonView,
    SessionView,
    TeamMemberView,
    TeamView,
} from '../shared/api/routes';
import type { AuthHarness, TestBrowser, TestResponse } from './auth-harness';
import { lastEmail, problemCode, requestOptions, signUp, uniqueEmail } from './auth-flows';
import { createTestEngine, type TestEngine } from './test-engine';
import { signedHeartbeat, signedHeartbeatV2 } from './test-heartbeat';
import { DEV_MEMBER_KEY } from '../app/config';
import { fromBase64Url } from '../domain/auth/secrets';
import { memberKeySource } from '../domain/teams/member-key';

export interface TeamFlowFixture {
    readonly harness: AuthHarness;
    /** Engine IDs with a member revocation queued for this user. */
    revokedOn(userId: string): Promise<readonly string[]>;
}

interface Person {
    readonly browser: TestBrowser;
    readonly email: string;
    readonly userId: string;
    readonly orgId: string;
}

/**
 * Teams over HTTP (ADR 0018): teams, the organization's people, invitations, and who sees which engine. Runs on the
 * in-memory stores (unit project) and on D1 (workers project).
 */
export function describeTeamFlows(name: string, makeFixture: () => TeamFlowFixture): void {
    describe(name, () => {
        let fixture: TeamFlowFixture;
        let harness: AuthHarness;
        let people = 0;

        beforeEach(() => {
            fixture = makeFixture();
            harness = fixture.harness;
            people = 0;
        });

        async function person(email = uniqueEmail()): Promise<Person> {
            people++;
            const browser = harness.browser({ ip: `203.0.113.${String(people)}` });
            await signUp(harness, browser, email);
            const session = (await browser.request('GET', '/api/session')).body as SessionView;
            return { browser, email, userId: session.user.id, orgId: session.activeOrg.id };
        }

        async function owner(): Promise<Person> {
            const someone = await person();
            expect((await someone.browser.request('POST', '/api/billing/checkout', { planId: 'starter' })).status).toBe(
                200,
            );
            return someone;
        }

        function expectProblem(response: TestResponse, status: number, code: string): void {
            expect([response.status, problemCode(response)]).toEqual([status, code]);
        }

        async function createTeam(browser: TestBrowser, name = 'Client A'): Promise<TeamView> {
            harness.clock.advance(1);
            const response = await browser.request('POST', '/api/teams', { name });
            expect(response.status).toBe(200);
            return (response.body as { team: TeamView }).team;
        }

        async function teams(browser: TestBrowser): Promise<readonly TeamView[]> {
            return ((await browser.request('GET', '/api/teams')).body as { teams: TeamView[] }).teams;
        }

        async function engines(browser: TestBrowser): Promise<readonly string[]> {
            const body = (await browser.request('GET', '/api/engines')).body as { engines: EngineView[] };
            return body.engines.map((engine) => engine.engineId);
        }

        /** Links an engine to the team through a team link code, as "New team → link" does. */
        async function linkTestEngine(browser: TestBrowser, teamId: string): Promise<TestEngine> {
            const response = await browser.request('POST', `/api/teams/${teamId}/link-codes`);
            expect(response.status).toBe(200);
            const engine = await createTestEngine();
            const request = await engine.register(LinkCode.parse((response.body as LinkCodeView).linkCode));
            const registered = await harness.browser({ ip: '198.51.100.7' }).request('POST', REGISTER_PATH, request);
            expect(registered.status).toBe(200);
            const memberKey = (await memberKeySource(fromBase64Url(DEV_MEMBER_KEY))())?.publicKey;
            expect((registered.body as { memberKey: string }).memberKey).toBe(memberKey);
            return engine;
        }

        async function linkEngine(browser: TestBrowser, teamId: string): Promise<string> {
            return (await linkTestEngine(browser, teamId)).engineId;
        }

        async function invite(
            browser: TestBrowser,
            body: { readonly emails: readonly string[]; readonly role: string; readonly teamIds: readonly string[] },
        ): Promise<TestResponse> {
            return browser.request('POST', '/api/invites', body);
        }

        function inviteToken(to: string): string {
            const message = lastEmail(harness, to);
            if (message.template !== 'team-invite') {
                throw new Error(`expected an invitation, got ${message.template}`);
            }
            return new URL(message.link).hash.slice(1);
        }

        /** Invites a new person to the teams, signs them up and has them accept, then switches them to the organization. */
        async function joined(by: Person, teamIds: readonly string[], role = 'member'): Promise<Person> {
            const email = uniqueEmail('invited');
            expect((await invite(by.browser, { emails: [email], role, teamIds })).status).toBe(200);
            const token = inviteToken(email);
            const invited = await person(email);
            const accepted = await invited.browser.request('POST', '/api/invites/accept', { token });
            expect(accepted.body).toEqual({ orgId: by.orgId });
            expect((await invited.browser.request('POST', '/api/session/active-org', { orgId: by.orgId })).status).toBe(
                200,
            );
            return { ...invited, orgId: by.orgId };
        }

        async function stepUp(browser: TestBrowser): Promise<void> {
            const options = requestOptions(await browser.request('POST', '/api/auth/step-up/options'));
            const response = await browser.authenticator.assert(options);
            expect((await browser.request('POST', '/api/auth/step-up/verify', { response })).status).toBe(200);
        }

        it('creates, renames and lists teams with their people', async () => {
            const boss = await owner();
            const team = await createTeam(boss.browser);
            expect(team).toMatchObject({ name: 'Client A', engineId: null, memberCount: 1, isMember: true });
            const renamed = await boss.browser.request('POST', `/api/teams/${team.teamId}/name`, { name: 'Client B' });
            expect((renamed.body as { team: TeamView }).team.name).toBe('Client B');
            const detail = (await boss.browser.request('GET', `/api/teams/${team.teamId}`)).body as {
                team: TeamView;
                members: PersonView[];
            };
            expect(detail.members.map((member) => [member.email, member.role])).toEqual([[boss.email, 'owner']]);
            expect((await teams(boss.browser)).map((t) => t.name)).toEqual(['Client B']);
            const missing = await boss.browser.request('POST', `/api/teams/${'a'.repeat(26)}/name`, { name: 'X' });
            expectProblem(missing, 404, 'not-found');
            expectProblem(await boss.browser.request('POST', '/api/teams', { name: '<b>' }), 400, 'invalid-request');
        });

        it('lets a member see only their teams and those teams’ engines', async () => {
            const boss = await owner();
            const mine = await createTeam(boss.browser, 'Theirs');
            const hidden = await createTeam(boss.browser, 'Hidden');
            const theirEngine = await linkEngine(boss.browser, mine.teamId);
            await linkEngine(boss.browser, hidden.teamId);
            const member = await joined(boss, [mine.teamId]);

            expect((await teams(member.browser)).map((t) => [t.name, t.isMember])).toEqual([['Theirs', true]]);
            expect(await engines(member.browser)).toEqual([theirEngine]);
            expect((await engines(boss.browser)).length).toBe(2);
            expect((await teams(boss.browser)).map((t) => t.isMember)).toEqual([true, true]);
            expect((await member.browser.request('GET', `/api/teams/${mine.teamId}`)).status).toBe(200);
            expectProblem(await member.browser.request('GET', `/api/teams/${hidden.teamId}`), 404, 'not-found');
            const otherEngine = (await engines(boss.browser)).find((id) => id !== theirEngine) ?? '';
            expectProblem(await member.browser.request('GET', `/api/engines/${otherEngine}`), 404, 'not-found');
            expect((await member.browser.request('GET', `/api/engines/${theirEngine}`)).status).toBe(200);
            expectProblem(await member.browser.request('POST', '/api/teams', { name: 'Mine' }), 403, 'forbidden');
            expectProblem(await member.browser.request('GET', '/api/org/members'), 403, 'forbidden');
        });

        it('links one engine per team through a team link code', async () => {
            const boss = await owner();
            const team = await createTeam(boss.browser);
            const engineId = await linkEngine(boss.browser, team.teamId);
            expect((await teams(boss.browser))[0]?.engineId).toBe(engineId);
            expectProblem(
                await boss.browser.request('POST', `/api/teams/${team.teamId}/link-codes`),
                409,
                'team-has-engine',
            );
            expectProblem(
                await boss.browser.request('POST', `/api/teams/${'a'.repeat(26)}/link-codes`),
                404,
                'not-found',
            );
        });

        it('refuses a team link code the plan does not allow', async () => {
            const someone = await person();
            const team = await createTeam(someone.browser);
            expectProblem(
                await someone.browser.request('POST', `/api/teams/${team.teamId}/link-codes`),
                403,
                'not-entitled',
            );
        });

        it('invites by email: one use, for that address only, and never after it lapses or is revoked', async () => {
            const boss = await owner();
            const team = await createTeam(boss.browser);
            const email = uniqueEmail('invited');
            const response = await invite(boss.browser, {
                emails: [email, email.toUpperCase()],
                role: 'member',
                teamIds: [team.teamId],
            });
            expect(response.body).toEqual({ results: [{ email, outcome: 'invited' }] });
            const token = inviteToken(email);
            const message = lastEmail(harness, email);
            expect(message).toMatchObject({
                template: 'team-invite',
                inviterEmail: boss.email,
                teamNames: ['Client A'],
            });

            const preview = await harness.browser().request('POST', '/api/invites/preview', { token });
            expect(preview.body).toMatchObject({ orgName: null, teamNames: ['Client A'], email });

            const stranger = await person();
            expectProblem(
                await stranger.browser.request('POST', '/api/invites/accept', { token }),
                403,
                'email-mismatch',
            );
            const invited = await person(email);
            expect((await invited.browser.request('POST', '/api/invites/accept', { token })).status).toBe(200);
            expectProblem(
                await invited.browser.request('POST', '/api/invites/accept', { token }),
                404,
                'invite-invalid',
            );
            expectProblem(await harness.browser().request('POST', '/api/invites/preview', { token }), 404, 'not-found');

            const lapsed = uniqueEmail('lapsed');
            await invite(boss.browser, { emails: [lapsed], role: 'member', teamIds: [] });
            const lapsedToken = inviteToken(lapsed);
            harness.clock.advance(7 * 24 * 60 * 60 * 1000);
            const late = await person(lapsed);
            expectProblem(
                await late.browser.request('POST', '/api/invites/accept', { token: lapsedToken }),
                404,
                'invite-invalid',
            );
        });

        it('resends and revokes pending invitations, and lists them with the organization’s people', async () => {
            const boss = await owner();
            const team = await createTeam(boss.browser);
            const email = uniqueEmail('pending');
            await invite(boss.browser, { emails: [email], role: 'admin', teamIds: [team.teamId] });
            const first = inviteToken(email);
            const listed = (await boss.browser.request('GET', '/api/org/members')).body as {
                members: OrgMemberView[];
                invites: { inviteId: string; email: string; role: string }[];
            };
            expect(listed.members.map((member) => [member.email, member.role, member.teamIds])).toEqual([
                [boss.email, 'owner', [team.teamId]],
            ]);
            const [pending] = listed.invites;
            expect(pending).toMatchObject({ email, role: 'admin' });
            const inviteId = pending?.inviteId ?? '';

            await stepUp(boss.browser);
            expect((await boss.browser.request('POST', `/api/teams/${team.teamId}/delete`)).status).toBe(204);
            expect((await boss.browser.request('POST', `/api/invites/${inviteId}/resend`)).status).toBe(204);
            expect(lastEmail(harness, email)).toMatchObject({ teamNames: [] });
            const second = inviteToken(email);
            expect(second).not.toBe(first);
            expectProblem(
                await harness.browser().request('POST', '/api/invites/preview', { token: first }),
                404,
                'not-found',
            );
            expect((await boss.browser.request('POST', `/api/invites/${inviteId}/revoke`)).status).toBe(204);
            expectProblem(await boss.browser.request('POST', `/api/invites/${inviteId}/revoke`), 404, 'not-found');
            expectProblem(await boss.browser.request('POST', `/api/invites/${inviteId}/resend`), 404, 'not-found');
            expectProblem(
                await harness.browser().request('POST', '/api/invites/preview', { token: second }),
                404,
                'not-found',
            );
        });

        it('adds people already in the organization to teams without an email, and refuses outsiders', async () => {
            const boss = await owner();
            const first = await createTeam(boss.browser, 'First');
            const second = await createTeam(boss.browser, 'Second');
            const member = await joined(boss, [first.teamId]);
            const sent = harness.outbox.sentTo(member.email).length;
            const again = await invite(boss.browser, {
                emails: [member.email],
                role: 'member',
                teamIds: [second.teamId],
            });
            expect(again.body).toEqual({ results: [{ email: member.email, outcome: 'added' }] });
            expect(harness.outbox.sentTo(member.email)).toHaveLength(sent);
            expect((await teams(member.browser)).map((t) => t.name)).toEqual(['First', 'Second']);

            const outsider = await person();
            expectProblem(
                await boss.browser.request('POST', `/api/teams/${first.teamId}/members`, { userId: outsider.userId }),
                409,
                'not-member',
            );
            expect(
                (await boss.browser.request('POST', `/api/teams/${first.teamId}/members`, { userId: member.userId }))
                    .status,
            ).toBe(204);
            expectProblem(
                await boss.browser.request('POST', `/api/teams/${'a'.repeat(26)}/members`, { userId: member.userId }),
                404,
                'not-found',
            );
            expectProblem(
                await invite(boss.browser, { emails: ['not an email'], role: 'member', teamIds: [] }),
                400,
                'invalid-email',
            );
            expectProblem(
                await invite(boss.browser, { emails: [uniqueEmail()], role: 'member', teamIds: ['a'.repeat(26)] }),
                404,
                'team-not-found',
            );
        });

        it('lets only owners invite owners and change roles, and keeps an owner', async () => {
            const boss = await owner();
            const admin = await joined(boss, [], 'admin');
            const member = await joined(boss, []);
            expectProblem(
                await invite(admin.browser, { emails: [uniqueEmail()], role: 'owner', teamIds: [] }),
                403,
                'forbidden',
            );
            expect((await invite(boss.browser, { emails: [uniqueEmail()], role: 'owner', teamIds: [] })).status).toBe(
                200,
            );
            expectProblem(
                await admin.browser.request('POST', `/api/org/members/${member.userId}/role`, { role: 'admin' }),
                403,
                'forbidden',
            );
            expectProblem(
                await boss.browser.request('POST', `/api/org/members/${boss.userId}/role`, { role: 'member' }),
                409,
                'last-owner',
            );
            expect(
                (await boss.browser.request('POST', `/api/org/members/${member.userId}/role`, { role: 'admin' }))
                    .status,
            ).toBe(204);
            expect(
                (await boss.browser.request('POST', `/api/org/members/${member.userId}/role`, { role: 'admin' }))
                    .status,
            ).toBe(204);
            expectProblem(
                await boss.browser.request('POST', `/api/org/members/${'a'.repeat(26)}/role`, { role: 'admin' }),
                404,
                'not-found',
            );
        });

        it('removes people from teams and the organization, queuing revocations; admins never remove an owner', async () => {
            const boss = await owner();
            const team = await createTeam(boss.browser);
            const engineId = await linkEngine(boss.browser, team.teamId);
            const admin = await joined(boss, [team.teamId], 'admin');
            const member = await joined(boss, [team.teamId]);

            expectProblem(
                await admin.browser.request('POST', `/api/org/members/${boss.userId}/remove`),
                403,
                'forbidden',
            );
            expect(
                (await admin.browser.request('POST', `/api/teams/${team.teamId}/members/${member.userId}/remove`))
                    .status,
            ).toBe(204);
            expectProblem(
                await admin.browser.request('POST', `/api/teams/${team.teamId}/members/${member.userId}/remove`),
                404,
                'not-found',
            );
            expect(await fixture.revokedOn(member.userId)).toEqual([engineId]);
            expect(await engines(member.browser)).toEqual([]);

            expect((await admin.browser.request('POST', `/api/org/members/${member.userId}/remove`)).status).toBe(204);
            expectProblem(
                await admin.browser.request('POST', `/api/org/members/${member.userId}/remove`),
                404,
                'not-found',
            );
            expect((await member.browser.request('GET', '/api/teams')).status).toBe(401);

            expect((await boss.browser.request('POST', `/api/org/members/${admin.userId}/remove`)).status).toBe(204);
            expect(await fixture.revokedOn(admin.userId)).toEqual([engineId]);
            expectProblem(
                await boss.browser.request('POST', `/api/org/members/${boss.userId}/remove`),
                409,
                'last-owner',
            );
        });

        it('lets people leave a team and an organization, moving their session home; the last owner stays', async () => {
            const boss = await owner();
            const team = await createTeam(boss.browser);
            const member = await joined(boss, [team.teamId]);
            expect((await member.browser.request('POST', `/api/teams/${team.teamId}/leave`)).status).toBe(204);
            expectProblem(await member.browser.request('POST', `/api/teams/${team.teamId}/leave`), 404, 'not-found');
            expect((await member.browser.request('POST', '/api/org/leave')).status).toBe(204);
            const session = (await member.browser.request('GET', '/api/session')).body as SessionView;
            expect(session.activeOrg.id).not.toBe(boss.orgId);
            expectProblem(await boss.browser.request('POST', '/api/org/leave'), 409, 'last-owner');
        });

        it('deletes a team after a step-up: its engine is revoked and its people hear nothing more of it', async () => {
            const boss = await owner();
            const team = await createTeam(boss.browser);
            const engineId = await linkEngine(boss.browser, team.teamId);
            const member = await joined(boss, [team.teamId]);
            expectProblem(
                await boss.browser.request('POST', `/api/teams/${team.teamId}/delete`),
                403,
                'step-up-required',
            );
            await stepUp(boss.browser);
            expect((await boss.browser.request('POST', `/api/teams/${team.teamId}/delete`)).status).toBe(204);
            expectProblem(await boss.browser.request('POST', `/api/teams/${team.teamId}/delete`), 404, 'not-found');
            expect(await teams(boss.browser)).toEqual([]);
            const engine = (await boss.browser.request('GET', `/api/engines/${engineId}`)).body as {
                engine: EngineView;
            };
            expect(engine.engine.suspendedBy).toBe('owner');
            expect(await fixture.revokedOn(member.userId)).toEqual([engineId]);
        });

        it('deletes a team without an engine', async () => {
            const boss = await owner();
            const team = await createTeam(boss.browser);
            await stepUp(boss.browser);
            expect((await boss.browser.request('POST', `/api/teams/${team.teamId}/delete`)).status).toBe(204);
        });

        async function memberKeyBytes(): Promise<Uint8Array<ArrayBuffer>> {
            const key = await memberKeySource(fromBase64Url(DEV_MEMBER_KEY))();
            return ed25519PublicKeyToBytes(key?.publicKey ?? ('' as never));
        }

        async function open(browser: TestBrowser, teamId: string): Promise<TestResponse> {
            return browser.request('POST', `/api/teams/${teamId}/access-ticket`);
        }

        /** The ticket an "Open" sent the browser off with, as the engine's join page verifies it. */
        async function openTicket(browser: TestBrowser, teamId: string, engineId: EngineId) {
            const response = await open(browser, teamId);
            expect(response.status).toBe(200);
            const url = new URL((response.body as { url: string }).url);
            expect(url.origin).toBe(`https://${engineId}.engines.ptbk.test`);
            expect(url.pathname).toBe('/auth/join');
            const verified = await verifyAccessTicket({
                token: url.hash.slice(1),
                memberKey: await memberKeyBytes(),
                engineId,
                now: Timestamp.parse(new Date(harness.clock.nowMs()).toISOString()),
            });
            if (verified.kind !== 'accepted') {
                throw new Error(`ticket refused: ${verified.kind}`);
            }
            return verified.ticket;
        }

        async function members(browser: TestBrowser, teamId: string) {
            return (await browser.request('GET', `/api/teams/${teamId}`)).body as {
                members: TeamMemberView[];
                removing: PersonView[];
                invites: { email: string }[];
            };
        }

        let seq = 0;
        async function beatV2(
            engine: TestEngine,
            teams: Parameters<typeof signedHeartbeatV2>[3] = {},
        ): Promise<HeartbeatReply> {
            seq++;
            harness.clock.advance(60_000);
            const heartbeat = await signedHeartbeatV2(engine, seq, harness.clock.nowMs(), teams);
            const response = await harness.post(heartbeatPath(engine.engineId), heartbeat.body, heartbeat.headers);
            expect(response.status).toBe(200);
            return HeartbeatReply.parse(response.body);
        }

        it('opens a team’s engine with a signed ticket, only for people in the team', async () => {
            const boss = await owner();
            const team = await createTeam(boss.browser);
            expectProblem(await open(boss.browser, team.teamId), 404, 'not-found');
            const engine = await linkTestEngine(boss.browser, team.teamId);
            const member = await joined(boss, [team.teamId]);
            const admin = await joined(boss, [], 'admin');

            const ticket = await openTicket(member.browser, team.teamId, engine.engineId);
            expect(ticket).toMatchObject({
                dashboardUserId: member.userId,
                email: member.email,
                proposedRole: 'member',
            });
            expect((await openTicket(boss.browser, team.teamId, engine.engineId)).proposedRole).toBe('admin');
            expectProblem(await open(admin.browser, team.teamId), 404, 'not-found');

            const detail = await members(boss.browser, team.teamId);
            expect(detail.members.find((person) => person.userId === member.userId)?.access).toBe('waiting');
            expect(detail.members.find((person) => person.userId === boss.userId)?.access).toBe('waiting');
            expect(await members(boss.browser, team.teamId)).toMatchObject({ removing: [], invites: [] });
        });

        it('hears the engine: emails a waiting request once, grants access on approval, and resends removals until acked', async () => {
            const boss = await owner();
            const team = await createTeam(boss.browser);
            const engine = await linkTestEngine(boss.browser, team.teamId);
            const member = await joined(boss, [team.teamId]);
            const pendingEmail = uniqueEmail('pending');
            await invite(boss.browser, { emails: [pendingEmail], role: 'member', teamIds: [team.teamId] });
            expect((await members(boss.browser, team.teamId)).invites.map((i) => i.email)).toEqual([pendingEmail]);

            // A v1 heartbeat still gets 204 and no reply.
            seq++;
            harness.clock.advance(60_000);
            const v1 = await signedHeartbeat(engine, seq, harness.clock.nowMs());
            expect((await harness.post(heartbeatPath(engine.engineId), v1.body, v1.headers)).status).toBe(204);

            const ticket = await openTicket(member.browser, team.teamId, engine.engineId);
            expect(await beatV2(engine)).toEqual({ v: 1, revocations: [] });
            expect(harness.outbox.sentTo(boss.email).some((m) => m.template === 'access-waiting')).toBe(false);
            await beatV2(engine, { accessRequests: 1 });
            const waiting = harness.outbox.sentTo(boss.email).filter((m) => m.template === 'access-waiting');
            expect(waiting).toHaveLength(1);
            expect(waiting[0]).toMatchObject({ requesterEmail: member.email, teamName: 'Client A' });
            await beatV2(engine, { accessRequests: 1 });
            expect(harness.outbox.sentTo(boss.email).filter((m) => m.template === 'access-waiting')).toHaveLength(1);

            await beatV2(engine, { acks: [{ id: ticket.ticketId, outcome: 'approved' }] });
            expect(lastEmail(harness, member.email)).toMatchObject({
                template: 'access-granted',
                teamName: 'Client A',
            });
            expect(
                (await members(boss.browser, team.teamId)).members.find((p) => p.userId === member.userId)?.access,
            ).toBe('approved');

            await boss.browser.request('POST', `/api/teams/${team.teamId}/members/${member.userId}/remove`);
            expect((await members(boss.browser, team.teamId)).removing.map((p) => p.userId)).toEqual([member.userId]);
            const reply = await beatV2(engine);
            expect(reply.revocations).toHaveLength(1);
            const revocation = await verifyMemberRevocation({
                token: reply.revocations[0] ?? '',
                memberKey: await memberKeyBytes(),
                engineId: engine.engineId,
            });
            if (revocation.kind !== 'accepted') {
                throw new Error(`revocation refused: ${revocation.kind}`);
            }
            expect(revocation.revocation.dashboardUserId).toBe(member.userId);
            expect((await beatV2(engine)).revocations).toHaveLength(1);
            await beatV2(engine, { acks: [{ id: revocation.revocation.revocationId, outcome: 'revoked' }] });
            expect((await beatV2(engine)).revocations).toEqual([]);
            expect((await members(boss.browser, team.teamId)).removing).toEqual([]);
        });
    });
}
