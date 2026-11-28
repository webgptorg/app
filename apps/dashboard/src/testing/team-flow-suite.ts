import { orgIdSchema } from '../domain/ids';
import { utcDay } from '../domain/usage/usage-day';
import type { UsageView } from '../shared/api/usage';
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
    PendingLinkCodesView,
    OrgMemberView,
    PersonView,
    SessionView,
    TeamMemberView,
    TeamView,
} from '../shared/api/routes';
import type { AuthHarness, TestBrowser, TestResponse } from './auth-harness';
import {
    creationOptions,
    lastEmail,
    linkToken,
    problemCode,
    registerWith,
    requestOptions,
    signIn,
    signUp,
    uniqueEmail,
} from './auth-flows';
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
            expect(accepted.body).toEqual({ orgId: by.orgId, teamIds });
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

        it('shows owners and admins what the meters count, and members nothing (ADR 0025)', async () => {
            const boss = await owner();
            const team = await createTeam(boss.browser);
            const empty = await createTeam(boss.browser, 'Client B');
            const engineId = await linkEngine(boss.browser, team.teamId);
            const colleague = await joined(boss, [team.teamId]);
            const response = await boss.browser.request('GET', '/api/usage');
            expect(response.status).toBe(200);
            const view = response.body as UsageView;
            const meter = (id: string) => view.meters.find((entry) => entry.meter === id);
            expect(view.overLimit).toBe('block');
            expect(meter('projects')).toEqual({
                meter: 'projects',
                limits: { org: 2, project: null },
                org: { value: 1, unreported: 0 },
                teams: [
                    { teamId: team.teamId, value: 1, unreported: 0 },
                    { teamId: empty.teamId, value: 0, unreported: 0 },
                ],
                projects: [{ engineId, value: 1, unreported: 0 }],
            });
            // No heartbeat has reached a rollup yet: unknown, not zero.
            expect(meter('agents')?.org).toEqual({ value: 0, unreported: 1 });
            expect(meter('people')?.org).toEqual({ value: 2, unreported: 0 });
            expect(meter('people')?.projects).toEqual([{ engineId, value: 2, unreported: 0 }]);
            expect(view.history).toEqual([]);
            const day = utcDay(harness.clock.nowMs());
            const orgId = orgIdSchema.parse(boss.orgId);
            await harness.deps.metering.upsertMeterDays([
                {
                    day,
                    orgId,
                    scope: 'org',
                    scopeId: orgId,
                    meter: 'projects',
                    value: 1,
                    unreported: 0,
                },
                {
                    day,
                    orgId,
                    scope: 'team',
                    scopeId: team.teamId,
                    meter: 'projects',
                    value: 1,
                    unreported: 0,
                },
            ]);
            expect(((await boss.browser.request('GET', '/api/usage')).body as UsageView).history).toEqual([
                { day, meter: 'projects', value: 1, unreported: 0, peak: 1 },
            ]);
            expectProblem(await colleague.browser.request('GET', '/api/usage'), 403, 'forbidden');
        });

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

        it('ends a team’s earlier code when the team gets a new one, and leaves other codes alone', async () => {
            const boss = await owner();
            const team = await createTeam(boss.browser);
            const issue = async (path: string) => {
                const response = await boss.browser.request('POST', path);
                expect(response.status).toBe(200);
                return response.body as LinkCodeView;
            };
            const first = await issue(`/api/teams/${team.teamId}/link-codes`);
            const untouched = await issue('/api/engines/link-codes');
            const second = await issue(`/api/teams/${team.teamId}/link-codes`);
            const listed = (await boss.browser.request('GET', '/api/engines/link-codes')).body as PendingLinkCodesView;
            expect(listed.linkCodes.map((code) => code.linkCodeId).sort()).toEqual(
                [second.linkCodeId, untouched.linkCodeId].sort(),
            );
            expect((await boss.browser.request('GET', `/api/engines/link-codes/${first.linkCodeId}`)).body).toEqual({
                status: 'expired',
            });
            const engine = await createTestEngine();
            const register = async (code: string) =>
                harness
                    .browser({ ip: '198.51.100.7' })
                    .request('POST', REGISTER_PATH, await engine.register(LinkCode.parse(code)));
            expectProblem(await register(first.linkCode), 401, 'invalid-link-code');
            expect((await register(second.linkCode)).status).toBe(200);
            expect((await teams(boss.browser))[0]?.engineId).toBe(engine.engineId);
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

        describe('joining from the invitation page (D-31)', () => {
            const JOIN_OPTIONS = '/api/invites/join/options';
            const JOIN_VERIFY = '/api/invites/join/verify';
            const SIGNIN_VERIFY = '/api/invites/signin/verify';

            async function invited(teamNames: readonly string[] = ['Client A']) {
                const boss = await owner();
                const teamIds: string[] = [];
                for (const name of teamNames) {
                    teamIds.push((await createTeam(boss.browser, name)).teamId);
                }
                const email = uniqueEmail('joiner');
                await invite(boss.browser, { emails: [email], role: 'member', teamIds });
                return { boss, email, teamIds, token: inviteToken(email) };
            }

            interface Joined {
                readonly session: SessionView;
                readonly joined: { readonly orgId: string; readonly teamIds: readonly string[] };
            }

            it('creates the account, its passkey and a session in the organization, and accepts, in one step', async () => {
                const { boss, email, teamIds, token } = await invited();
                const browser = harness.browser({ ip: '203.0.113.200' });
                const preview = await browser.request('POST', '/api/invites/preview', { token });
                expect(preview.body).toMatchObject({ email, hasAccount: false });
                expect(browser.cookies.get('__Host-ptbk_invite')).toBe(token);

                // No token in the body, as after a reload: the cookie the preview set still has it.
                const { verify } = await registerWith(browser, JOIN_OPTIONS, JOIN_VERIFY, {});
                expect(verify.status).toBe(200);
                const body = verify.body as Joined;
                expect(body.joined).toEqual({ orgId: boss.orgId, teamIds });
                expect(body.session.user.email).toBe(email);
                expect(body.session.activeOrg).toMatchObject({ id: boss.orgId, role: 'member' });
                expect(body.session.memberships.map((membership) => membership.orgId)).toEqual([boss.orgId]);
                expect(browser.cookies.has('__Host-ptbk_invite')).toBe(false);
                // No confirmation email: the invitation link proved the address.
                expect(harness.outbox.sentTo(email).map((message) => message.template)).toEqual(['team-invite']);
                expect((await teams(browser)).map((team) => [team.teamId, team.isMember])).toEqual([
                    [teamIds[0], true],
                ]);

                const later = harness.browser({ authenticator: browser.authenticator });
                expect((await signIn(later)).verify.status).toBe(200);
                expectProblem(await browser.request('POST', JOIN_OPTIONS, { token }), 404, 'invite-invalid');
            });

            it('refuses the new-account path for an address with an account, and a lapsed invitation', async () => {
                const { email, token } = await invited();
                await person(email);
                const browser = harness.browser({ ip: '203.0.113.201' });
                expect((await browser.request('POST', '/api/invites/preview', { token })).body).toMatchObject({
                    hasAccount: true,
                });
                expectProblem(await browser.request('POST', JOIN_OPTIONS, { token }), 409, 'account-exists');

                const lapsed = await invited([]);
                const late = harness.browser({ ip: '203.0.113.202' });
                expect((await late.request('POST', '/api/invites/preview', { token: lapsed.token })).status).toBe(200);
                // The invitation lapses during the passkey prompt: the challenge still holds, the invitation does not.
                harness.clock.advance(7 * 24 * 60 * 60 * 1000 - 30_000);
                const options = creationOptions(await late.request('POST', JOIN_OPTIONS, { token: lapsed.token }));
                const response = await late.authenticator.register(options);
                harness.clock.advance(60_000);
                expectProblem(
                    await late.request('POST', JOIN_VERIFY, { token: lapsed.token, response }),
                    404,
                    'invite-invalid',
                );
                expectProblem(await late.request('POST', JOIN_OPTIONS, { token: lapsed.token }), 404, 'invite-invalid');
                expectProblem(await late.request('POST', '/api/invites/preview', {}), 404, 'not-found');
                expect(late.cookies.has('__Host-ptbk_invite')).toBe(false);
            });

            it('makes no second account when the address signs up between options and verify', async () => {
                const { email, token } = await invited();
                const browser = harness.browser({ ip: '203.0.113.203' });
                const options = creationOptions(await browser.request('POST', JOIN_OPTIONS, { token }));
                const response = await browser.authenticator.register(options);
                await person(email);
                expectProblem(await browser.request('POST', JOIN_VERIFY, { token, response }), 409, 'account-exists');
                expect(browser.cookies.has('__Host-ptbk_session')).toBe(false);
            });

            it('refuses a reused invitation and a challenge issued for another invitation', async () => {
                const first = await invited();
                const browser = harness.browser({ ip: '203.0.113.204' });
                const { verify } = await registerWith(browser, JOIN_OPTIONS, JOIN_VERIFY, { token: first.token });
                expect(verify.status).toBe(200);
                const again = harness.browser({ ip: '203.0.113.205' });
                expectProblem(await again.request('POST', JOIN_OPTIONS, { token: first.token }), 404, 'invite-invalid');

                const second = await invited();
                const third = await invited();
                const mixed = harness.browser({ ip: '203.0.113.206' });
                const options = creationOptions(await mixed.request('POST', JOIN_OPTIONS, { token: second.token }));
                const response = await mixed.authenticator.register(options);
                expectProblem(
                    await mixed.request('POST', JOIN_VERIFY, { token: third.token, response }),
                    400,
                    'challenge-invalid',
                );
                expect((await mixed.request('POST', '/api/invites/preview', { token: third.token })).status).toBe(200);
            });

            it('signs an existing account in to the organization and accepts, and refuses another account', async () => {
                const { boss, email, teamIds, token } = await invited();
                // Still signed in to the account's own organization: signing in to join replaces that session.
                const joiner = await person(email);

                const stranger = await person();
                const strangerOptions = requestOptions(
                    await stranger.browser.request('POST', '/api/auth/signin/options'),
                );
                expectProblem(
                    await stranger.browser.request('POST', SIGNIN_VERIFY, {
                        token,
                        response: await stranger.browser.authenticator.assert(strangerOptions),
                    }),
                    403,
                    'email-mismatch',
                );

                const { browser } = joiner;
                await browser.request('POST', '/api/invites/preview', { token });
                const options = requestOptions(await browser.request('POST', '/api/auth/signin/options'));
                const response = await browser.authenticator.assert(options);
                const verify = await browser.request('POST', SIGNIN_VERIFY, { response });
                expect(verify.status).toBe(200);
                const body = verify.body as Joined;
                expect(body.joined).toEqual({ orgId: boss.orgId, teamIds });
                expect(body.session.activeOrg.id).toBe(boss.orgId);
                expect(body.session.memberships.map((membership) => membership.orgId).sort()).toEqual(
                    [joiner.orgId, boss.orgId].sort(),
                );
                expect(browser.cookies.has('__Host-ptbk_invite')).toBe(false);

                const reused = requestOptions(await browser.request('POST', '/api/auth/signin/options'));
                expectProblem(
                    await browser.request('POST', SIGNIN_VERIFY, {
                        token,
                        response: await browser.authenticator.assert(reused),
                    }),
                    404,
                    'invite-invalid',
                );
            });

            it('refuses a passkey the ceremony did not ask for', async () => {
                const { email, token } = await invited();
                const browser = harness.browser({ ip: '203.0.113.207' });
                const { verify } = await registerWith(
                    browser,
                    JOIN_OPTIONS,
                    JOIN_VERIFY,
                    { token },
                    { origin: 'https://evil.example' },
                );
                expect([verify.status, problemCode(verify)]).toEqual([401, 'webauthn-failed']);

                const joiner = await person(email);
                await joiner.browser.request('POST', '/api/auth/signout');
                const options = requestOptions(await joiner.browser.request('POST', '/api/auth/signin/options'));
                const forged = await joiner.browser.authenticator.assert(options, { origin: 'https://evil.example' });
                expectProblem(
                    await joiner.browser.request('POST', SIGNIN_VERIFY, { token, response: forged }),
                    401,
                    'webauthn-failed',
                );
                // No challenge from this browser: a replayed assertion has nothing to answer.
                const replayed = await joiner.browser.authenticator.assert(options);
                expectProblem(
                    await harness.browser({ ip: '203.0.113.208' }).request('POST', SIGNIN_VERIFY, {
                        token,
                        response: replayed,
                    }),
                    400,
                    'challenge-invalid',
                );
            });

            it('signs in and joins from a browser that has no session', async () => {
                const { boss, email, token } = await invited();
                const joiner = await person(email);
                await joiner.browser.request('POST', '/api/auth/signout');
                const options = requestOptions(await joiner.browser.request('POST', '/api/auth/signin/options'));
                const response = await joiner.browser.authenticator.assert(options);
                const verify = await joiner.browser.request('POST', SIGNIN_VERIFY, { token, response });
                expect(verify.status).toBe(200);
                expect((verify.body as Joined).session.activeOrg.id).toBe(boss.orgId);
            });

            it('accepts with the cookie when already signed in, and says which teams it was for', async () => {
                const { boss, email, teamIds, token } = await invited();
                const joiner = await person(email);
                await joiner.browser.request('POST', '/api/invites/preview', { token });
                const accepted = await joiner.browser.request('POST', '/api/invites/accept', {});
                expect(accepted.body).toEqual({ orgId: boss.orgId, teamIds });
                expectProblem(await joiner.browser.request('POST', '/api/invites/accept', {}), 404, 'invite-invalid');
            });

            it('rate-limits the join ceremony per IP', async () => {
                const { token } = await invited();
                const browser = harness.browser({ ip: '203.0.113.210' });
                for (let attempt = 0; attempt < 30; attempt++) {
                    expect((await browser.request('POST', JOIN_OPTIONS, { token })).status).toBe(200);
                }
                expectProblem(await browser.request('POST', JOIN_OPTIONS, { token }), 429, 'rate-limited');
                for (let attempt = 0; attempt < 30; attempt++) {
                    await browser.request('POST', JOIN_VERIFY, { token, response: {} });
                }
                expectProblem(
                    await browser.request('POST', SIGNIN_VERIFY, { token, response: {} }),
                    429,
                    'rate-limited',
                );
            });
        });

        describe('offering pending invitations after sign-in (D-33)', () => {
            const OFFERS = '/api/invites/offers';
            const accept = (inviteId: string) => `/api/invites/offers/${inviteId}/accept`;

            interface Offer {
                readonly inviteId: string;
                readonly orgName: string | null;
                readonly inviterEmail: string | null;
                readonly teamNames: readonly string[];
                readonly expiresAt: number;
            }

            async function offers(browser: TestBrowser): Promise<readonly Offer[]> {
                const response = await browser.request('GET', OFFERS);
                expect(response.status).toBe(200);
                return (response.body as { offers: Offer[] }).offers;
            }

            async function invitedTo(by: Person, email: string, teamIds: readonly string[] = []): Promise<string> {
                harness.clock.advance(1);
                expect((await invite(by.browser, { emails: [email], role: 'member', teamIds })).status).toBe(200);
                const listed = (await by.browser.request('GET', '/api/org/members')).body as {
                    invites: { inviteId: string; email: string }[];
                };
                return listed.invites.find((pending) => pending.email === email.toLowerCase())?.inviteId ?? '';
            }

            it('offers the invitations to the account’s address, from any organization, and accepts one by ID', async () => {
                const boss = await owner();
                const team = await createTeam(boss.browser);
                const email = uniqueEmail('offered');
                const first = await invitedTo(boss, email.toUpperCase(), [team.teamId]);
                const elsewhere = await owner();
                const second = await invitedTo(elsewhere, email);
                // Signed up from scratch, not from the link: the invitation waits for them all the same.
                const joiner = await person(email);

                expect(await offers(joiner.browser)).toEqual([
                    {
                        inviteId: second,
                        orgName: null,
                        inviterEmail: elsewhere.email,
                        teamNames: [],
                        expiresAt: expect.any(Number) as number,
                    },
                    {
                        inviteId: first,
                        orgName: null,
                        inviterEmail: boss.email,
                        teamNames: ['Client A'],
                        expiresAt: expect.any(Number) as number,
                    },
                ]);
                const accepted = await joiner.browser.request('POST', accept(first));
                expect(accepted.body).toEqual({ orgId: boss.orgId, teamIds: [team.teamId] });
                expect((await offers(joiner.browser)).map((offer) => offer.inviteId)).toEqual([second]);
                expectProblem(await joiner.browser.request('POST', accept(first)), 404, 'invite-invalid');

                const session = (await joiner.browser.request('GET', '/api/session')).body as SessionView;
                expect(session.activeOrg.id).toBe(joiner.orgId);
                expect(session.memberships.map((membership) => membership.orgId)).toContain(boss.orgId);
                expect((await joiner.browser.request('POST', accept(second))).status).toBe(200);
                expect(await offers(joiner.browser)).toEqual([]);
            });

            it('never offers or accepts another address’s, a lapsed, a revoked or a used invitation', async () => {
                const boss = await owner();
                const email = uniqueEmail('offered');
                const forSomeoneElse = await invitedTo(boss, uniqueEmail('someone-else'));
                const revoked = await invitedTo(boss, email);
                const used = await invitedTo(boss, email);
                const usedToken = inviteToken(email);
                const joiner = await person(email);
                const stranger = await person();

                expect(await offers(stranger.browser)).toEqual([]);
                expectProblem(await stranger.browser.request('POST', accept(revoked)), 404, 'invite-invalid');
                expectProblem(await joiner.browser.request('POST', accept(forSomeoneElse)), 404, 'invite-invalid');

                expect((await boss.browser.request('POST', `/api/invites/${revoked}/revoke`)).status).toBe(204);
                expect((await joiner.browser.request('POST', '/api/invites/accept', { token: usedToken })).status).toBe(
                    200,
                );
                expect(await offers(joiner.browser)).toEqual([]);
                expectProblem(await joiner.browser.request('POST', accept(revoked)), 404, 'invite-invalid');
                expectProblem(await joiner.browser.request('POST', accept(used)), 404, 'invite-invalid');

                const late = uniqueEmail('late');
                const lapsed = await invitedTo(boss, late);
                harness.clock.advance(7 * 24 * 60 * 60 * 1000);
                const latecomer = await person(late);
                expect(await offers(latecomer.browser)).toEqual([]);
                expectProblem(await latecomer.browser.request('POST', accept(lapsed)), 404, 'invite-invalid');
            });

            describe('adding a passkey from the invitation page (D-35)', () => {
                const RECOVERY = '/api/auth/recovery/request';
                const fromInvite = { kind: 'invite' };

                it('words the recovery email for joining, then offers the invitation once the passkey is added', async () => {
                    const boss = await owner();
                    const email = uniqueEmail('offered');
                    const laptop = await person(email);
                    const inviteId = await invitedTo(boss, email);
                    const phone = harness.browser({ ip: '203.0.113.230' });

                    expect((await phone.request('POST', RECOVERY, { email, context: fromInvite })).status).toBe(202);
                    const sent = lastEmail(harness, email);
                    expect(sent).toMatchObject({ template: 'invite-passkey-link', orgName: null });
                    expect(sent.template === 'invite-passkey-link' ? sent.link : '').toMatch(
                        /^https:\/\/app\.ptbk\.test\/recover\?via=invite#[\w-]{43}$/,
                    );

                    const token = linkToken(harness, email);
                    const { verify } = await registerWith(
                        phone,
                        '/api/auth/recovery/options',
                        '/api/auth/recovery/verify',
                        { token },
                    );
                    expect(verify.status).toBe(200);
                    expect((await offers(phone)).map((offer) => offer.inviteId)).toEqual([inviteId]);
                    // The same recovery underneath: the other device is signed out and the notice goes out.
                    expectProblem(await laptop.browser.request('GET', '/api/session'), 401, 'unauthorized');
                    expect(lastEmail(harness, email)).toMatchObject({ template: 'recovery-notice' });
                });

                it('sends the plain recovery email without a pending invitation or without the context', async () => {
                    const boss = await owner();
                    const loner = await person(uniqueEmail('loner'));
                    const invited = await person(uniqueEmail('offered'));
                    await invitedTo(boss, invited.email);
                    const device = harness.browser({ ip: '203.0.113.231' });

                    expect(
                        (await device.request('POST', RECOVERY, { email: loner.email, context: fromInvite })).status,
                    ).toBe(202);
                    expect((await device.request('POST', RECOVERY, { email: invited.email })).status).toBe(202);
                    for (const { email } of [loner, invited]) {
                        expect(lastEmail(harness, email)).toEqual(
                            expect.objectContaining({
                                template: 'recovery-link',
                                link: expect.stringMatching(/^https:\/\/app\.ptbk\.test\/recover#/) as string,
                            }),
                        );
                    }
                });

                it('answers the same for any address and rejects any other context', async () => {
                    const boss = await owner();
                    const email = uniqueEmail('offered');
                    await person(email);
                    await invitedTo(boss, email);
                    const device = harness.browser({ ip: '203.0.113.232' });
                    const known = await device.request('POST', RECOVERY, { email, context: fromInvite });
                    const unknown = await device.request('POST', RECOVERY, {
                        email: uniqueEmail(),
                        context: fromInvite,
                    });
                    expect([known.status, JSON.stringify(known.body)]).toEqual([
                        unknown.status,
                        JSON.stringify(unknown.body),
                    ]);
                    expect([...known.headers]).toEqual([...unknown.headers]);

                    for (const context of [
                        { kind: 'invite', orgName: 'Not from the server' },
                        { kind: 'recovery' },
                        'invite',
                        null,
                    ]) {
                        expectProblem(
                            await device.request('POST', RECOVERY, { email, context }),
                            400,
                            'invalid-request',
                        );
                    }
                });
            });

            it('needs a session and limits both routes per IP', async () => {
                const browser = harness.browser({ ip: '203.0.113.220' });
                const inviteId = 'a'.repeat(26);
                for (let attempt = 0; attempt < 30; attempt++) {
                    expectProblem(await browser.request('POST', accept(inviteId)), 401, 'unauthorized');
                }
                expectProblem(await browser.request('POST', accept(inviteId)), 429, 'rate-limited');
                for (let attempt = 0; attempt < 120; attempt++) {
                    expectProblem(await browser.request('GET', OFFERS), 401, 'unauthorized');
                }
                expectProblem(await browser.request('GET', OFFERS), 429, 'rate-limited');
            });
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

        it('never lets an admin take an owner out of a team, which would revoke them on its engine', async () => {
            const boss = await owner();
            const team = await createTeam(boss.browser);
            await linkEngine(boss.browser, team.teamId);
            const coOwner = await joined(boss, [team.teamId], 'owner');
            const admin = await joined(boss, [team.teamId], 'admin');

            expectProblem(
                await admin.browser.request('POST', `/api/teams/${team.teamId}/members/${coOwner.userId}/remove`),
                403,
                'forbidden',
            );
            expect((await members(boss.browser, team.teamId)).members.map((p) => p.userId)).toContain(coOwner.userId);
            expect(await fixture.revokedOn(coOwner.userId)).toEqual([]);

            expect(
                (await boss.browser.request('POST', `/api/teams/${team.teamId}/members/${coOwner.userId}/remove`))
                    .status,
            ).toBe(204);
            expect((await admin.browser.request('POST', `/api/teams/${team.teamId}/leave`)).status).toBe(204);
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
            const teamAdmin = await joined(boss, [team.teamId], 'admin');
            expect((await openTicket(teamAdmin.browser, team.teamId, engine.engineId)).proposedRole).toBe('admin');
            expectProblem(await open(admin.browser, team.teamId), 404, 'not-found');

            const detail = await members(boss.browser, team.teamId);
            expect(detail.members.find((person) => person.userId === member.userId)?.access).toBe('waiting');
        });

        it('sends whoever linked the engine straight to it: a ticket would make its owner ask themselves', async () => {
            const boss = await owner();
            const team = await createTeam(boss.browser);
            const engine = await linkTestEngine(boss.browser, team.teamId);

            const detail = await members(boss.browser, team.teamId);
            expect(detail.members.find((person) => person.userId === boss.userId)?.access).toBe('approved');

            const opened = await open(boss.browser, team.teamId);
            expect(opened.status).toBe(200);
            expect(opened.body).toEqual({
                url: `https://${engine.engineId}.engines.ptbk.test/`,
                expiresAt: null,
            });
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
            const hostname = `${engine.engineId}.engines.ptbk.test`;
            expect(waiting[0]).toMatchObject({
                requesterEmail: member.email,
                teamName: 'Client A',
                link: `https://${hostname}/members`,
            });
            await beatV2(engine, { accessRequests: 1 });
            expect(harness.outbox.sentTo(boss.email).filter((m) => m.template === 'access-waiting')).toHaveLength(1);

            await beatV2(engine, { acks: [{ id: ticket.ticketId, outcome: 'approved' }] });
            expect(lastEmail(harness, member.email)).toMatchObject({
                template: 'access-granted',
                teamName: 'Client A',
                hostname,
                link: `https://${hostname}/`,
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

        type Call = readonly [method: string, path: string, body?: unknown];

        async function pendingInviteId(browser: TestBrowser): Promise<string> {
            const listed = (await browser.request('GET', '/api/org/members')).body as {
                invites: { inviteId: string }[];
            };
            return listed.invites[0]?.inviteId ?? '';
        }

        it('keeps teams and people from members, and roles and billing from admins', async () => {
            const boss = await owner();
            const team = await createTeam(boss.browser);
            const admin = await joined(boss, [team.teamId], 'admin');
            const member = await joined(boss, [team.teamId]);
            await invite(boss.browser, { emails: [uniqueEmail()], role: 'member', teamIds: [] });
            const inviteId = await pendingInviteId(boss.browser);
            const managers: readonly Call[] = [
                ['POST', '/api/teams', { name: 'Mine' }],
                ['POST', `/api/teams/${team.teamId}/name`, { name: 'Renamed' }],
                ['POST', `/api/teams/${team.teamId}/delete`],
                ['POST', `/api/teams/${team.teamId}/link-codes`],
                ['GET', '/api/engines/link-codes'],
                ['POST', `/api/engines/link-codes/${'a'.repeat(26)}/cancel`],
                ['POST', `/api/teams/${team.teamId}/members`, { userId: admin.userId }],
                ['POST', `/api/teams/${team.teamId}/members/${admin.userId}/remove`],
                ['GET', '/api/org/members'],
                ['POST', `/api/org/members/${admin.userId}/remove`],
                ['POST', '/api/invites', { emails: [uniqueEmail()], role: 'member', teamIds: [] }],
                ['POST', `/api/invites/${inviteId}/resend`],
                ['POST', `/api/invites/${inviteId}/revoke`],
            ];
            const owners: readonly Call[] = [
                ['POST', `/api/org/members/${member.userId}/role`, { role: 'admin' }],
                ['POST', `/api/org/members/${admin.userId}/role`, { role: 'owner' }],
                ['GET', '/api/billing'],
                ['POST', '/api/billing/checkout', { planId: 'starter' }],
                ['POST', '/api/billing/portal'],
            ];
            for (const [method, path, body] of [...managers, ...owners]) {
                const response = await member.browser.request(method, path, body);
                expect([path, response.status, problemCode(response)]).toEqual([path, 403, 'forbidden']);
            }
            for (const [method, path, body] of owners) {
                const response = await admin.browser.request(method, path, body);
                expect([path, response.status, problemCode(response)]).toEqual([path, 403, 'forbidden']);
            }

            const after = (await boss.browser.request('GET', '/api/org/members')).body as {
                members: OrgMemberView[];
                invites: unknown[];
            };
            expect(after.members.map((person) => [person.userId, person.role]).sort()).toEqual(
                [
                    [boss.userId, 'owner'],
                    [admin.userId, 'admin'],
                    [member.userId, 'member'],
                ].sort(),
            );
            expect(after.invites).toHaveLength(1);
            expect((await teams(boss.browser)).map((t) => [t.name, t.memberCount])).toEqual([['Client A', 3]]);
        });

        it('answers another organization’s teams, people and invitations as missing, and changes none of them', async () => {
            const boss = await owner();
            const team = await createTeam(boss.browser);
            await linkEngine(boss.browser, team.teamId);
            const member = await joined(boss, [team.teamId]);
            await invite(boss.browser, { emails: [uniqueEmail()], role: 'member', teamIds: [team.teamId] });
            const inviteId = await pendingInviteId(boss.browser);
            const rival = await owner();
            const rivalTeam = await createTeam(rival.browser, 'Rival');
            await stepUp(rival.browser);

            const calls: readonly Call[] = [
                ['GET', `/api/teams/${team.teamId}`],
                ['POST', `/api/teams/${team.teamId}/name`, { name: 'Taken' }],
                ['POST', `/api/teams/${team.teamId}/delete`],
                ['POST', `/api/teams/${team.teamId}/link-codes`],
                ['POST', `/api/teams/${team.teamId}/access-ticket`],
                ['POST', `/api/teams/${team.teamId}/members`, { userId: rival.userId }],
                ['POST', `/api/teams/${team.teamId}/members/${member.userId}/remove`],
                ['POST', `/api/teams/${team.teamId}/leave`],
                ['POST', `/api/org/members/${member.userId}/role`, { role: 'admin' }],
                ['POST', `/api/org/members/${member.userId}/remove`],
                ['POST', `/api/invites/${inviteId}/resend`],
                ['POST', `/api/invites/${inviteId}/revoke`],
            ];
            for (const [method, path, body] of calls) {
                const response = await rival.browser.request(method, path, body);
                expect([path, response.status, problemCode(response)]).toEqual([path, 404, 'not-found']);
            }
            expectProblem(
                await rival.browser.request('POST', `/api/teams/${rivalTeam.teamId}/members`, {
                    userId: member.userId,
                }),
                409,
                'not-member',
            );
            expectProblem(
                await invite(rival.browser, { emails: [uniqueEmail()], role: 'member', teamIds: [team.teamId] }),
                404,
                'team-not-found',
            );
            expect((await teams(rival.browser)).map((t) => t.teamId)).toEqual([rivalTeam.teamId]);
            expect(await engines(rival.browser)).toEqual([]);

            const detail = await members(boss.browser, team.teamId);
            expect(detail.members.map((p) => p.userId).sort()).toEqual([boss.userId, member.userId].sort());
            expect(detail.invites).toHaveLength(1);
            expect((await teams(boss.browser)).map((t) => t.name)).toEqual(['Client A']);
            expect(await fixture.revokedOn(member.userId)).toEqual([]);
        });

        it('ignores acks for IDs it never issued, or issued to another engine', async () => {
            const boss = await owner();
            const team = await createTeam(boss.browser);
            const engine = await linkTestEngine(boss.browser, team.teamId);
            const otherTeam = await createTeam(boss.browser, 'Client B');
            const other = await linkTestEngine(boss.browser, otherTeam.teamId);
            const member = await joined(boss, [team.teamId]);
            const leaving = await joined(boss, [team.teamId]);
            const ticket = await openTicket(member.browser, team.teamId, engine.engineId);
            await boss.browser.request('POST', `/api/teams/${team.teamId}/members/${leaving.userId}/remove`);
            const [token] = (await beatV2(engine)).revocations;
            const revocation = await verifyMemberRevocation({
                token: token ?? '',
                memberKey: await memberKeyBytes(),
                engineId: engine.engineId,
            });
            if (revocation.kind !== 'accepted') {
                throw new Error(`revocation refused: ${revocation.kind}`);
            }
            const { revocationId } = revocation.revocation;
            const sent = harness.outbox.sentTo(member.email).length;

            expect(
                await beatV2(other, {
                    acks: [
                        { id: ticket.ticketId, outcome: 'approved' },
                        { id: revocationId, outcome: 'revoked' },
                        { id: 'n'.repeat(43), outcome: 'approved' },
                    ],
                }),
            ).toEqual({ v: 1, revocations: [] });
            await beatV2(engine, {
                acks: [
                    { id: ticket.ticketId, outcome: 'revoked' },
                    { id: revocationId, outcome: 'approved' },
                    { id: 'n'.repeat(43), outcome: 'removed' },
                ],
            });

            const detail = await members(boss.browser, team.teamId);
            expect(detail.members.find((p) => p.userId === member.userId)?.access).toBe('waiting');
            expect(detail.removing.map((p) => p.userId)).toEqual([leaving.userId]);
            expect(harness.outbox.sentTo(member.email)).toHaveLength(sent);
            expect((await beatV2(engine)).revocations).toEqual([token]);
        });

        it('never logs an invitation token, an access ticket or a revocation', async () => {
            const boss = await owner();
            const team = await createTeam(boss.browser);
            const engine = await linkTestEngine(boss.browser, team.teamId);
            const member = await joined(boss, [team.teamId]);
            const inviteTokens = harness.outbox
                .sentTo(member.email)
                .flatMap((message) =>
                    message.template === 'team-invite' ? [new URL(message.link).hash.slice(1)] : [],
                );
            const opened = await open(member.browser, team.teamId);
            const ticket = new URL((opened.body as { url: string }).url).hash.slice(1);
            const { ticketId } = await openTicket(member.browser, team.teamId, engine.engineId);
            await beatV2(engine, { accessRequests: 1, acks: [{ id: ticketId, outcome: 'approved' }] });
            await boss.browser.request('POST', `/api/teams/${team.teamId}/members/${member.userId}/remove`);
            const [revocation] = (await beatV2(engine)).revocations;

            const secrets = [...inviteTokens, ticket, ticketId, revocation ?? ''];
            expect(secrets.every((secret) => secret.length >= 16)).toBe(true);
            const logged = JSON.stringify(harness.logger.entries);
            for (const secret of secrets) {
                expect(logged).not.toContain(secret);
            }
        });
    });
}
