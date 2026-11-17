import { createFormatters } from '@ptbk/ui';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apiRoutes, type TeamView } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import {
    AUTHENTICATION_OPTIONS,
    AUTHENTICATION_RESPONSE,
    ENGINE_ID,
    engineView,
    NOW,
    REGISTRATION_OPTIONS,
    session,
} from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import { ok, problem, type ScriptedApi } from '../../testing/scripted-api';
import { CONTINUE_DELAY_MS } from './invite-page';

const TEAM_ID = 'tttttttttttttttttttttttttt';
const OTHER_TEAM = 'uuuuuuuuuuuuuuuuuuuuuuuuuu';
const ADMIN = session({
    permissions: [
        'org.read',
        'engine.read',
        'engine.link',
        'team.read',
        'team.leave',
        'team.manage',
        'team.delete',
        'team.members.manage',
        'org.members.read',
        'org.members.manage',
        'org.roles.manage',
        'org.leave',
    ],
});
const MEMBER = session({ permissions: ['org.read', 'engine.read', 'team.read', 'team.leave', 'org.leave'] });

function team(overrides: Partial<TeamView> = {}): TeamView {
    return {
        teamId: TEAM_ID,
        name: 'Northwind' as TeamView['name'],
        engineId: ENGINE_ID as TeamView['engineId'],
        memberCount: 3,
        isMember: true,
        createdAt: NOW,
        ...overrides,
    };
}

function person(email: string, role: 'owner' | 'admin' | 'member', userId: string) {
    return { userId, email, role, joinedAt: NOW };
}

function teamPage(api: ScriptedApi) {
    api.on(apiRoutes.listEngines, ok({ engines: [engineView()] }));
    api.on(apiRoutes.listTeams, ok({ teams: [team()] }));
    api.on(
        apiRoutes.getTeam,
        ok({
            team: team(),
            members: [
                { ...person('ann@example.test', 'member', 'a1aaaaaaaaaaaaaaaaaaaaaaaa'), access: 'approved' as const },
                { ...person('bob@example.test', 'member', 'b1bbbbbbbbbbbbbbbbbbbbbbbb'), access: 'waiting' as const },
                { ...person('ada@example.test', 'owner', 'aaaaaaaaaaaaaaaaaaaaaaaaaa'), access: 'none' as const },
            ],
            removing: [person('cy@example.test', 'member', 'c1cccccccccccccccccccccccc')],
            refused: [
                { ...person('dee@example.test', 'member', 'd1dddddddddddddddddddddddd'), outcome: 'refused-disabled' },
            ],
            invites: [
                {
                    inviteId: 'd1dddddddddddddddddddddddd',
                    email: 'dana@example.test',
                    role: 'admin' as const,
                    teamIds: [TEAM_ID],
                    createdAt: NOW,
                    expiresAt: NOW + 7 * 86_400_000,
                },
            ],
        }),
    );
}

describe('teams list', () => {
    it('is the landing page: teams with their engine status and Open for the teams one is in', async () => {
        const app = renderApp({
            path: '/',
            session: ADMIN,
            script: (api) => {
                api.on(apiRoutes.listEngines, ok({ engines: [engineView()] }));
                api.on(
                    apiRoutes.listTeams,
                    ok({
                        teams: [
                            team(),
                            team({
                                teamId: OTHER_TEAM,
                                name: 'Contoso' as TeamView['name'],
                                engineId: null,
                                isMember: false,
                            }),
                        ],
                    }),
                );
                api.on(
                    apiRoutes.createAccessTicket,
                    ok({ url: `https://${ENGINE_ID}.engines.ptbk.test/auth/join#ticket`, expiresAt: NOW }),
                );
            },
        });
        expect(await screen.findByRole('heading', { name: 'Engines' })).toBeTruthy();
        expect(app.history.location.pathname).toBe('/engines');
        const list = await screen.findByRole('list', { name: 'Engines' });
        const [first, second] = within(list).getAllByRole('listitem');
        if (first === undefined || second === undefined) throw new Error('two teams');
        expect(within(first).getByText('Online')).toBeTruthy();
        expect(within(second).getByText('Not linked yet')).toBeTruthy();
        expect(within(second).queryByRole('button', { name: /Open/ })).toBeNull();
        await expectNoAxeViolations(app.container);
        await app.user.click(within(first).getByRole('button', { name: 'Open Northwind' }));
        await waitFor(() => {
            expect(app.navigations).toEqual([`https://${ENGINE_ID}.engines.ptbk.test/auth/join#ticket`]);
        });
    });

    it('lists unused link codes with their expiry and revokes one after asking', async () => {
        const formatters = createFormatters('en');
        const format = (at: number) => formatters.formatDateTime(new Date(at));
        const code = { linkCodeId: 'k1kkkkkkkkkkkkkkkkkkkkkkkk', createdAt: NOW, expiresAt: NOW + 30 * 86_400_000 };
        const app = renderApp({
            path: '/engines',
            session: ADMIN,
            script: (api) => {
                api.on(apiRoutes.listTeams, ok({ teams: [team()] }));
                api.once(apiRoutes.listLinkCodes, ok({ linkCodes: [code] }));
                api.on(apiRoutes.listLinkCodes, ok({ linkCodes: [] }));
                api.on(apiRoutes.cancelLinkCode, ok(undefined));
            },
        });
        const list = await screen.findByRole('list', { name: 'Unused link codes' });
        const created = format(code.createdAt);
        expect(within(list).getByText(`Created ${created}`)).toBeTruthy();
        expect(within(list).getByText(`Works until ${format(code.expiresAt)}`)).toBeTruthy();
        await expectNoAxeViolations(app.container);
        await app.user.click(
            within(list).getByRole('button', { name: `Actions for the link code created ${created}` }),
        );
        await app.user.click(screen.getByRole('menuitem', { name: 'Revoke code' }));
        const dialog = await screen.findByRole('dialog', { name: 'Revoke this link code?' });
        expect(app.api.callsTo(apiRoutes.cancelLinkCode)).toEqual([]);
        await app.user.click(within(dialog).getByRole('button', { name: 'Revoke code' }));
        expect(await screen.findByText('Link code revoked.')).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.cancelLinkCode)).toEqual([{ params: { linkCodeId: code.linkCodeId } }]);
        await waitFor(() => {
            expect(screen.queryByRole('list', { name: 'Unused link codes' })).toBeNull();
        });
    });

    it('shows no link codes to someone who cannot link engines', async () => {
        const app = renderApp({
            path: '/engines',
            session: MEMBER,
            script: (api) => {
                api.on(apiRoutes.listTeams, ok({ teams: [team()] }));
            },
        });
        expect(await screen.findByRole('list', { name: 'Engines' })).toBeTruthy();
        expect(screen.queryByText('Unused link codes')).toBeNull();
        expect(app.api.callsTo(apiRoutes.listLinkCodes)).toEqual([]);
    });

    it('says why Open failed when the dashboard has no member key', async () => {
        const app = renderApp({
            path: '/teams',
            session: ADMIN,
            script: (api) => {
                api.on(apiRoutes.listTeams, ok({ teams: [team()] }));
                api.on(apiRoutes.createAccessTicket, problem(503, 'unavailable'));
            },
        });
        await app.user.click(await screen.findByRole('button', { name: 'Open Northwind' }));
        expect(await screen.findByText("Opening engines isn't available right now. Try again later.")).toBeTruthy();
        expect(app.navigations).toEqual([]);
    });

    it('creates a team and goes on to link its engine', async () => {
        const app = renderApp({
            path: '/teams',
            session: ADMIN,
            script: (api) => {
                api.on(apiRoutes.createTeam, ok({ team: team({ engineId: null, memberCount: 1 }) }));
                api.on(
                    apiRoutes.linkEligibility,
                    ok({
                        eligibility: 'engine-limit',
                        linkCodeTtlS: 2_592_000,
                        installGuideUrl: 'https://docs.example.test/install',
                    }),
                );
            },
        });
        expect(await screen.findByRole('heading', { name: 'No engines yet' })).toBeTruthy();
        await app.user.click(screen.getByRole('button', { name: 'New engine' }));
        await app.user.click(screen.getByRole('button', { name: 'Create and link an engine' }));
        expect(await screen.findByText(/Use letters, digits/)).toBeTruthy();
        await app.user.type(screen.getByLabelText('Engine name'), 'Northwind');
        await app.user.click(screen.getByRole('button', { name: 'Create and link an engine' }));
        await waitFor(() => {
            expect(app.history.location.pathname).toBe('/engines/new');
        });
        expect(app.history.location.search).toContain(`team=${TEAM_ID}`);
        expect(app.api.callsTo(apiRoutes.createTeam)).toEqual([{ body: { name: 'Northwind' } }]);
        expect(await screen.findByRole('heading', { name: 'Link an engine', level: 1 })).toBeTruthy();
    });

    it('tells a member in no team whom to ask', async () => {
        renderApp({ path: '/teams', session: MEMBER });
        expect(await screen.findByRole('heading', { name: "You're not on an engine yet" })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'New engine' })).toBeNull();
        expect(screen.queryByRole('link', { name: 'People' })).toBeNull();
    });
});

describe('team page', () => {
    it('shows where each person stands, and invites more people to this team', async () => {
        const app = renderApp({
            path: `/teams/${TEAM_ID}`,
            session: ADMIN,
            script: (api) => {
                teamPage(api);
                api.on(
                    apiRoutes.createInvites,
                    ok({ results: [{ email: 'eve@example.test', outcome: 'invited' as const }] }),
                );
            },
        });
        expect(await screen.findByRole('heading', { name: 'Northwind', level: 1 })).toBeTruthy();
        const people = screen.getByRole('region', { name: 'People' });
        for (const [email, state] of [
            ['ann@example.test', 'Has access'],
            ['bob@example.test', 'Waiting for approval'],
            ['ada@example.test', 'Not opened yet'],
            ['dana@example.test', 'Invited'],
            ['cy@example.test', 'Removing…'],
            ['dee@example.test', 'Still on the engine'],
        ] as const) {
            const row = within(people).getByText(email).closest('li');
            expect(row === null ? null : within(row).getByText(state)).toBeTruthy();
        }
        await expectNoAxeViolations(app.container);

        await app.user.click(within(people).getByRole('button', { name: 'Invite to this engine' }));
        const dialog = await screen.findByRole('dialog', { name: 'Invite people to Northwind' });
        expect(within(dialog).getByRole('checkbox', { name: 'Northwind' })).toHaveProperty('checked', true);
        await app.user.click(within(dialog).getByRole('button', { name: 'Send invitations' }));
        expect(within(dialog).getByText('Enter one or more email addresses.')).toBeTruthy();
        await app.user.type(within(dialog).getByLabelText('Email addresses'), 'eve@example.test, eve@example.test');
        await app.user.selectOptions(within(dialog).getByLabelText('Role in the organization'), 'admin');
        await app.user.click(within(dialog).getByRole('button', { name: 'Send invitations' }));
        expect(await screen.findByText('Invitations sent: 1')).toBeTruthy();
        expect(screen.getByText(/what the engine has told the dashboard/)).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.createInvites)).toEqual([
            { body: { emails: ['eve@example.test'], role: 'admin', teamIds: [TEAM_ID] } },
        ]);
    });

    it('removes someone from the team, and lets one leave it', async () => {
        const app = renderApp({
            path: `/teams/${TEAM_ID}`,
            session: ADMIN,
            script: (api) => {
                teamPage(api);
                api.on(apiRoutes.removeTeamMember, ok(undefined));
                api.on(apiRoutes.leaveTeam, ok(undefined));
            },
        });
        await app.user.click(await screen.findByRole('button', { name: 'Actions for bob@example.test' }));
        await app.user.click(screen.getByRole('menuitem', { name: 'Remove from engine' }));
        const confirm = await screen.findByRole('dialog', { name: 'Remove bob@example.test from the engine?' });
        await app.user.click(within(confirm).getByRole('button', { name: 'Remove from engine' }));
        expect(await screen.findByText('bob@example.test removed from the engine')).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.removeTeamMember)).toEqual([
            { params: { teamId: TEAM_ID, userId: 'b1bbbbbbbbbbbbbbbbbbbbbbbb' } },
        ]);
        await app.user.click(screen.getByRole('button', { name: 'Actions for ada@example.test' }));
        await app.user.click(screen.getByRole('menuitem', { name: 'Leave engine' }));
        const leave = await screen.findByRole('dialog', { name: 'Leave this engine?' });
        await app.user.click(within(leave).getByRole('button', { name: 'Leave engine' }));
        expect(await screen.findByText('You left the engine')).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.leaveTeam)).toEqual([{ params: { teamId: TEAM_ID } }]);
        // Nobody can be removed from an invitation or a removal in progress here.
        expect(screen.queryByRole('button', { name: 'Actions for dana@example.test' })).toBeNull();
    });

    it('offers an admin no way to take an owner out of the team', async () => {
        renderApp({
            path: `/teams/${TEAM_ID}`,
            session: { ...ADMIN, activeOrg: { ...ADMIN.activeOrg, role: 'admin' } },
            script: (api) => {
                teamPage(api);
                api.on(
                    apiRoutes.getTeam,
                    ok({
                        team: team(),
                        members: [
                            {
                                ...person('bob@example.test', 'member', 'b1bbbbbbbbbbbbbbbbbbbbbbbb'),
                                access: 'approved' as const,
                            },
                            {
                                ...person('eve@example.test', 'owner', 'e1eeeeeeeeeeeeeeeeeeeeeeee'),
                                access: 'approved' as const,
                            },
                        ],
                        removing: [],
                        refused: [],
                        invites: [],
                    }),
                );
            },
        });
        expect(await screen.findByRole('button', { name: 'Actions for bob@example.test' })).toBeTruthy();
        expect(screen.getByText('eve@example.test')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Actions for eve@example.test' })).toBeNull();
    });

    it('renames the team and deletes it after naming it', async () => {
        const app = renderApp({
            path: `/teams/${TEAM_ID}`,
            session: { ...ADMIN, steppedUpUntil: NOW + 60_000 },
            script: (api) => {
                teamPage(api);
                api.on(apiRoutes.renameTeam, ok({ team: team({ name: 'Northwind EU' as TeamView['name'] }) }));
                api.on(apiRoutes.deleteTeam, ok(undefined));
            },
        });
        await app.user.click(await screen.findByRole('button', { name: 'Actions for Northwind' }));
        await app.user.click(screen.getByRole('menuitem', { name: 'Rename' }));
        const rename = await screen.findByRole('dialog', { name: 'Rename engine' });
        await app.user.type(within(rename).getByLabelText('Engine name'), ' EU');
        await app.user.click(within(rename).getByRole('button', { name: 'Save' }));
        await waitFor(() => {
            expect(app.api.callsTo(apiRoutes.renameTeam)).toEqual([
                { params: { teamId: TEAM_ID }, body: { name: 'Northwind EU' } },
            ]);
        });
        await app.user.click(screen.getByRole('button', { name: 'Actions for Northwind' }));
        await app.user.click(screen.getByRole('menuitem', { name: 'Delete engine' }));
        const remove = await screen.findByRole('dialog', { name: 'Delete Northwind?' });
        await app.user.type(within(remove).getByRole('textbox'), 'Northwind');
        await app.user.click(within(remove).getByRole('button', { name: 'Delete engine' }));
        await waitFor(() => {
            expect(app.history.location.pathname).toBe('/engines');
        });
        expect(await screen.findByText('Northwind deleted')).toBeTruthy();
    });

    it('offers to link an engine to a team without one, and says when a team is gone', async () => {
        const app = renderApp({
            path: `/teams/${TEAM_ID}`,
            session: ADMIN,
            script: (api) => {
                api.on(
                    apiRoutes.getTeam,
                    ok({ team: team({ engineId: null }), members: [], removing: [], refused: [], invites: [] }),
                );
            },
        });
        const link = await screen.findByRole('link', { name: 'Link an engine' });
        expect(link.getAttribute('href')).toBe(`/engines/new?team=${TEAM_ID}`);
        expect(screen.queryByText(/what the engine has told the dashboard/)).toBeNull();
        expect(screen.queryByRole('button', { name: /^Open/ })).toBeNull();
        // No engine to name yet: the invitation is to the team.
        expect(screen.getByRole('button', { name: 'Invite people' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Invite to this engine' })).toBeNull();
        app.unmount();

        renderApp({
            path: `/teams/${OTHER_TEAM}`,
            session: MEMBER,
            script: (api) => api.on(apiRoutes.getTeam, problem(404, 'not-found')),
        });
        expect(await screen.findByRole('heading', { name: 'Engine not found' })).toBeTruthy();
    });
});

describe('people page', () => {
    function people(api: ScriptedApi) {
        api.on(apiRoutes.listTeams, ok({ teams: [team()] }));
        api.on(
            apiRoutes.listOrgMembers,
            ok({
                members: [
                    { ...person('ada@example.test', 'owner', 'aaaaaaaaaaaaaaaaaaaaaaaaaa'), teamIds: [TEAM_ID] },
                    { ...person('bob@example.test', 'member', 'b1bbbbbbbbbbbbbbbbbbbbbbbb'), teamIds: [] },
                ],
                invites: [
                    {
                        inviteId: 'd1dddddddddddddddddddddddd',
                        email: 'dana@example.test',
                        role: 'admin' as const,
                        teamIds: [],
                        createdAt: NOW,
                        expiresAt: NOW + 86_400_000,
                    },
                ],
            }),
        );
    }

    it('lists people with roles and teams, changes a role, and keeps the last owner', async () => {
        const app = renderApp({
            path: '/people',
            session: ADMIN,
            script: (api) => {
                people(api);
                api.once(apiRoutes.changeOrgRole, ok(undefined), problem(409, 'last-owner'));
            },
        });
        expect(await screen.findByText('Northwind')).toBeTruthy();
        expect(screen.getByText('No engines')).toBeTruthy();
        await expectNoAxeViolations(app.container);
        await app.user.click(screen.getByRole('button', { name: 'Actions for bob@example.test' }));
        await app.user.click(screen.getByRole('menuitemradio', { name: 'Admin' }));
        expect(await screen.findByText('bob@example.test is now Admin')).toBeTruthy();
        await app.user.click(screen.getByRole('button', { name: 'Actions for ada@example.test' }));
        await app.user.click(screen.getByRole('menuitemradio', { name: 'Member' }));
        expect(await screen.findByText('The organization needs at least one owner.')).toBeTruthy();
    });

    it('removes someone from the organization, and resends and revokes invitations', async () => {
        const app = renderApp({
            path: '/people',
            session: ADMIN,
            script: (api) => {
                people(api);
                api.on(apiRoutes.removeOrgMember, ok(undefined));
                api.on(apiRoutes.resendInvite, ok(undefined));
                api.on(apiRoutes.revokeInvite, ok(undefined));
            },
        });
        await app.user.click(await screen.findByRole('button', { name: 'Actions for bob@example.test' }));
        await app.user.click(screen.getByRole('menuitem', { name: 'Remove from organization' }));
        const confirm = await screen.findByRole('dialog', { name: 'Remove bob@example.test?' });
        await app.user.click(within(confirm).getByRole('button', { name: 'Remove from organization' }));
        expect(await screen.findByText('bob@example.test removed')).toBeTruthy();
        await app.user.click(screen.getByRole('button', { name: 'Actions for dana@example.test' }));
        await app.user.click(screen.getByRole('menuitem', { name: 'Resend invitation' }));
        expect(await screen.findByText('Invitation sent again to dana@example.test')).toBeTruthy();
        await app.user.click(screen.getByRole('button', { name: 'Actions for dana@example.test' }));
        await app.user.click(screen.getByRole('menuitem', { name: 'Revoke invitation' }));
        expect(await screen.findByText('Invitation for dana@example.test revoked')).toBeTruthy();
    });

    it('is for owners and admins only', async () => {
        renderApp({ path: '/people', session: MEMBER });
        expect(await screen.findByText("Only owners and admins see the organization's people.")).toBeTruthy();
    });
});

describe('invitation page', () => {
    const TOKEN = 'T'.repeat(43);
    const ORG_ID = 'cccccccccccccccccccccccccc';
    const JOINER = session({ permissions: MEMBER.activeOrg.permissions });
    const ENGINE_URL = 'https://northwind.engines.ptbk.test/auth/join#ticket';
    const preview = (api: ScriptedApi, overrides: { readonly hasAccount?: boolean; readonly email?: string } = {}) =>
        api.on(
            apiRoutes.previewInvite,
            ok({
                orgName: 'Acme',
                teamNames: ['Northwind' as TeamView['name']],
                email: overrides.email ?? 'ada@example.test',
                expiresAt: NOW,
                hasAccount: overrides.hasAccount ?? false,
            }),
        );
    const joinedWith = (teams: readonly TeamView[]) => (api: ScriptedApi) => {
        api.on(apiRoutes.listTeams, ok({ teams: [...teams] }));
        api.on(apiRoutes.createAccessTicket, ok({ url: ENGINE_URL, expiresAt: NOW + 15 * 60_000 }));
    };

    it('lets someone new join in one step, then explains the engine passkey and goes on to the engine', async () => {
        const app = renderApp({
            path: `/invites#${TOKEN}`,
            script: (api) => {
                preview(api);
                api.on(apiRoutes.inviteJoinOptions, ok({ options: REGISTRATION_OPTIONS }));
                api.on(
                    apiRoutes.inviteJoinVerify,
                    ok({ session: JOINER, joined: { orgId: ORG_ID, teamIds: [TEAM_ID] } }),
                );
                joinedWith([team()])(api);
            },
        });
        expect(await screen.findByRole('heading', { name: 'Join Acme' })).toBeTruthy();
        expect(screen.getByText('Northwind')).toBeTruthy();
        expect(app.history.location.hash).toBe('');
        expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
        await expectNoAxeViolations(app.container);

        await app.user.click(screen.getByRole('button', { name: 'Join Acme' }));
        expect(await screen.findByRole('heading', { name: "You're in" })).toBeTruthy();
        expect(
            screen.getByText('Next, confirm a passkey for the engine itself: it has its own secure address.'),
        ).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.inviteJoinOptions)).toEqual([{ body: { token: TOKEN } }]);
        expect(app.passkeys.register).toHaveBeenCalledWith(REGISTRATION_OPTIONS);
        await waitFor(
            () => {
                expect(app.navigations).toEqual([ENGINE_URL]);
            },
            { timeout: CONTINUE_DELAY_MS + 2000 },
        );
        expect(app.api.callsTo(apiRoutes.createAccessTicket)).toEqual([{ params: { teamId: TEAM_ID } }]);
    });

    it('signs an existing account in and joins, and lists several engines to open', async () => {
        const second = team({ teamId: OTHER_TEAM, name: 'Contoso' as TeamView['name'] });
        const app = renderApp({
            path: `/invites#${TOKEN}`,
            script: (api) => {
                preview(api, { hasAccount: true });
                api.on(apiRoutes.signinOptions, ok({ options: AUTHENTICATION_OPTIONS }));
                api.on(
                    apiRoutes.inviteSigninVerify,
                    ok({ session: JOINER, joined: { orgId: ORG_ID, teamIds: [TEAM_ID, OTHER_TEAM] } }),
                );
                joinedWith([team(), second])(api);
            },
        });
        expect(
            await screen.findByText(
                "You already have a Promptbook account for ada@example.test. Sign in with your passkey and you're in.",
            ),
        ).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Recover access' })).toBeTruthy();
        await app.user.click(screen.getByRole('button', { name: 'Sign in and join' }));
        expect(await screen.findByRole('button', { name: 'Open Contoso' })).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.inviteSigninVerify)).toEqual([
            { body: { token: TOKEN, response: AUTHENTICATION_RESPONSE } },
        ]);
        await app.user.click(screen.getByRole('button', { name: 'Open Northwind' }));
        await waitFor(() => {
            expect(app.navigations).toEqual([ENGINE_URL]);
        });
    });

    it('finds the invitation from its cookie after a reload, and switches to sign-in when the address has an account', async () => {
        const app = renderApp({
            path: '/invites',
            script: (api) => {
                api.once(
                    apiRoutes.previewInvite,
                    ok({ orgName: null, teamNames: [], email: 'ada@example.test', expiresAt: NOW, hasAccount: false }),
                );
                preview(api, { hasAccount: true });
                api.on(apiRoutes.inviteJoinOptions, problem(409, 'account-exists'));
            },
        });
        expect(await screen.findByRole('heading', { name: 'Join your colleagues on Promptbook' })).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.previewInvite)).toEqual([{ body: {} }]);
        await app.user.click(screen.getByRole('button', { name: 'Join' }));
        expect(await screen.findByRole('button', { name: 'Sign in and join' })).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.inviteJoinOptions)).toEqual([{ body: {} }]);
    });

    it('explains a passkey of another account and a cancelled prompt, with a retry', async () => {
        const app = renderApp({
            path: `/invites#${TOKEN}`,
            script: (api) => {
                preview(api, { hasAccount: true });
                api.on(apiRoutes.signinOptions, ok({ options: AUTHENTICATION_OPTIONS }));
                api.on(apiRoutes.inviteSigninVerify, problem(403, 'email-mismatch'));
            },
        });
        app.passkeys.failNext('cancelled');
        await app.user.click(await screen.findByRole('button', { name: 'Sign in and join' }));
        expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText(/That passkey belongs to a different account/)).toBeTruthy();
    });

    it('accepts for a signed-in person, and lands on the dashboard when no engine is set up yet', async () => {
        const app = renderApp({
            path: `/invites#${TOKEN}`,
            session: MEMBER,
            script: (api) => {
                preview(api);
                api.on(apiRoutes.acceptInvite, ok({ orgId: ORG_ID, teamIds: [TEAM_ID] }));
                api.on(apiRoutes.setActiveOrg, ok(MEMBER));
                joinedWith([team({ engineId: null })])(api);
            },
        });
        await app.user.click(await screen.findByRole('button', { name: 'Join Acme' }));
        expect(await screen.findByText(/No engine is set up for you yet/)).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Go to the dashboard' })).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.setActiveOrg)).toEqual([{ body: { orgId: ORG_ID } }]);
        // The token is spent: asking again would flash "no longer valid".
        expect(app.api.callsTo(apiRoutes.previewInvite)).toHaveLength(1);
        expect(app.navigations).toEqual([]);
    });

    it('offers to sign out here when signed in as someone else, then joins as the invited address', async () => {
        const app = renderApp({
            path: `/invites#${TOKEN}`,
            session: MEMBER,
            script: (api) => {
                preview(api, { email: 'eve@example.test' });
                api.on(apiRoutes.signout, ok({}));
            },
        });
        expect(
            await screen.findByText(
                "You're signed in as ada@example.test, but this invitation is for eve@example.test. Sign out here, then join as eve@example.test.",
            ),
        ).toBeTruthy();
        await app.user.click(screen.getByRole('button', { name: 'Sign out and continue' }));
        expect(await screen.findByRole('button', { name: 'Join Acme' })).toBeTruthy();
        expect(app.history.location.pathname).toBe('/invites');
    });

    it('explains an invitation that no longer works', async () => {
        const app = renderApp({
            path: `/invites#${TOKEN}`,
            session: MEMBER,
            script: (api) => {
                preview(api);
                api.once(apiRoutes.acceptInvite, problem(404, 'invite-invalid'));
            },
        });
        await app.user.click(await screen.findByRole('button', { name: 'Join Acme' }));
        expect(await screen.findAllByText(/no longer valid/)).toBeTruthy();
        app.unmount();

        renderApp({
            path: '/invites',
            session: MEMBER,
            script: (api) => api.on(apiRoutes.previewInvite, problem(404, 'not-found')),
        });
        expect(await screen.findByText(/no longer valid/)).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Go to the dashboard' })).toBeTruthy();
    });
});
