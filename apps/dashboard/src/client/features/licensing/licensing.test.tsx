import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apiRoutes, type LicenseView, type WebsitePendingView } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import { NOW, session } from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import type { ScriptedApi } from '../../testing/scripted-api';
import { ok, problem } from '../../testing/scripted-api';
import { afterSignUp, rememberWebsiteLink } from './website-link-marker';

const DAY = 86_400_000;
const MANAGER = session({
    licensing: true,
    billingEnabled: false,
    permissions: ['org.read', 'team.read', 'license.read', 'license.link', 'engine.link'],
});
const MEMBER = session({ licensing: true, billingEnabled: false, permissions: ['org.read', 'team.read'] });

function grant(overrides: Partial<LicenseView['grants'][number]> = {}): LicenseView['grants'][number] {
    return {
        id: crypto.randomUUID(),
        validFrom: new Date(NOW - 10 * DAY).toISOString(),
        validUntil: null,
        active: true,
        capabilities: {
            engineProjects: 1,
            specialists: 10,
            controllingUsers: 5,
            harnessInstances: null,
            browserProfiles: 5,
            remoteControl: true,
        },
        ...overrides,
    };
}

export function licenseView(overrides: Partial<LicenseView> = {}): LicenseView {
    return {
        link: { linkedAt: NOW - 3 * DAY, linkedByEmail: 'ada@example.test' },
        state: 'current',
        checkedAt: new Date(NOW - 2 * 3_600_000).toISOString(),
        manageUrl: 'https://www.ptbk.io/cs/pricing/predplatne',
        grants: [grant()],
        coverage: { engines: { used: 1, covered: 1, capacity: 1 }, people: { used: 2, limit: 5 } },
        notice: null,
        ...overrides,
    };
}

function withLicense(view: LicenseView) {
    return (api: ScriptedApi) => {
        api.on(apiRoutes.getLicense, ok(view));
        api.on(apiRoutes.listTeams, ok({ teams: [] }));
        api.on(apiRoutes.listEngines, ok({ engines: [] }));
        api.on(apiRoutes.listLinkCodes, ok({ linkCodes: [] }));
    };
}

describe('license page', () => {
    it('shows the linked account, coverage, each grant and the manage link on ptbk.io', async () => {
        const app = renderApp({
            path: '/license',
            session: MANAGER,
            script: withLicense(
                licenseView({
                    grants: [
                        grant(),
                        grant({
                            capabilities: {
                                engineProjects: null,
                                specialists: null,
                                controllingUsers: null,
                                harnessInstances: null,
                                browserProfiles: null,
                                remoteControl: false,
                            },
                        }),
                    ],
                    coverage: { engines: { used: 3, covered: 3, capacity: null }, people: { used: 2, limit: null } },
                }),
            ),
        });
        expect(await screen.findByRole('heading', { name: 'License', level: 1 })).toBeTruthy();
        expect(screen.getByText(/^Linked by ada@example\.test on /)).toBeTruthy();
        expect(screen.getByRole('link', { name: /Manage on ptbk\.io/ }).getAttribute('href')).toBe(
            'https://www.ptbk.io/cs/pricing/predplatne',
        );
        expect(screen.getByText('Last checked')).toBeTruthy();
        expect(screen.getByText('3, unlimited')).toBeTruthy();
        expect(screen.getByText('2 · unlimited')).toBeTruthy();
        const grants = screen.getAllByLabelText(/^Licence valid /);
        expect(grants).toHaveLength(2);
        expect(within(grants[1] as HTMLElement).getAllByText('Unlimited')).toHaveLength(5);
        expect(within(grants[1] as HTMLElement).getByText('Not included')).toBeTruthy();
        expect(screen.getByText(/don’t report specialists/)).toBeTruthy();
        expect(screen.queryByRole('link', { name: 'Billing' })).toBeNull();
        expect(screen.getByRole('link', { name: 'License' })).toBeTruthy();
        await expectNoAxeViolations(app.container);
    });

    it('offers to link an unlinked organization through the website', async () => {
        const app = renderApp({
            path: '/license',
            session: MANAGER,
            script: withLicense(
                licenseView({
                    link: null,
                    state: 'unknown',
                    checkedAt: null,
                    manageUrl: null,
                    grants: [],
                    coverage: null,
                    notice: 'unlinked',
                }),
            ),
        });
        await app.user.click(await screen.findByRole('button', { name: 'Link your ptbk.io account' }));
        expect(app.navigations).toEqual(['/api/website-access/start']);
        expect(screen.queryByRole('heading', { name: 'Licences' })).toBeNull();
    });

    it('says calmly when the website did not answer, showing the last snapshot', async () => {
        renderApp({ path: '/license', session: MANAGER, script: withLicense(licenseView({ state: 'stale' })) });
        expect(await screen.findByText('ptbk.io didn’t answer just now')).toBeTruthy();
        expect(screen.getAllByLabelText(/^Licence valid /)).toHaveLength(1);
    });

    it('says when a linked organization’s licence is not known yet, and who linked it once they left', async () => {
        renderApp({
            path: '/license',
            session: MANAGER,
            script: withLicense(
                licenseView({
                    link: { linkedAt: NOW - DAY, linkedByEmail: null },
                    state: 'unknown',
                    checkedAt: null,
                    manageUrl: null,
                    grants: [],
                    coverage: null,
                }),
            ),
        });
        expect(await screen.findByText(/hasn’t answered yet/)).toBeTruthy();
        expect(screen.getByText(/^Linked on /)).toBeTruthy();
        expect(screen.queryByRole('link', { name: /Manage on ptbk\.io/ })).toBeNull();
    });

    it('offers a retry when the licence cannot be loaded', async () => {
        const app = renderApp({
            path: '/license',
            session: MANAGER,
            script: (api) => api.on(apiRoutes.getLicense, problem(500, 'internal')),
        });
        expect(await screen.findByText('The licence couldn’t be loaded.', {}, { timeout: 5000 })).toBeTruthy();
        app.api.on(apiRoutes.getLicense, ok(licenseView()));
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText(/^Linked by /)).toBeTruthy();
    });

    it('marks expired and over-capacity coverage without blocking language', async () => {
        renderApp({
            path: '/license',
            session: MANAGER,
            script: withLicense(
                licenseView({
                    grants: [grant({ active: false, validUntil: new Date(NOW - DAY).toISOString() })],
                    coverage: { engines: { used: 2, covered: 0, capacity: 0 }, people: { used: 6, limit: 0 } },
                    notice: 'expired',
                }),
            ),
        });
        expect(await screen.findByText('Expired')).toBeTruthy();
        expect(screen.getAllByText('Not covered')).toHaveLength(2);
        expect(screen.getByText('2 of 0')).toBeTruthy();
        expect(screen.getByText('6 · up to 0 per engine')).toBeTruthy();
    });

    it('does not exist without website licensing, or for a member', async () => {
        renderApp({ path: '/license', session: session({ permissions: ['license.read'] }) });
        expect(await screen.findByRole('heading', { name: /not found/i })).toBeTruthy();
    });

    it('sends old billing links to the license page', async () => {
        const app = renderApp({ path: '/billing', session: MANAGER, script: withLicense(licenseView()) });
        expect(await screen.findByRole('heading', { name: 'License', level: 1 })).toBeTruthy();
        expect(app.history.location.pathname).toBe('/license');
    });
});

describe('engines notice', () => {
    it.each([
        ['exceeded', 'You use more than your licences cover. Nothing is stopped.'],
        ['expired', 'Your licence has expired. Your engines keep running; renew it on ptbk.io.'],
        ['missing', 'No active licence covers your engines. They keep running.'],
        ['unlinked', 'Link your ptbk.io account to see which engines your licences cover.'],
    ] as const)('says %s quietly, with a way to the license page', async (notice, text) => {
        renderApp({ path: '/engines', session: MANAGER, script: withLicense(licenseView({ notice })) });
        expect(await screen.findByText(text)).toBeTruthy();
        expect(screen.getByRole('link', { name: 'See license' }).getAttribute('href')).toBe('/license');
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('stays silent when covered, and for people who cannot read the licence', async () => {
        const covered = renderApp({ path: '/engines', session: MANAGER, script: withLicense(licenseView()) });
        await waitFor(() => {
            expect(covered.api.callsTo(apiRoutes.getLicense)).toHaveLength(1);
        });
        expect(screen.queryByText('See license')).toBeNull();
        covered.unmount();
        const member = renderApp({
            path: '/engines',
            session: MEMBER,
            script: withLicense(licenseView({ notice: 'exceeded' })),
        });
        expect(await screen.findByRole('heading', { name: 'Engines', level: 1 })).toBeTruthy();
        expect(member.api.callsTo(apiRoutes.getLicense)).toHaveLength(0);
    });
});

const PENDING: WebsitePendingView = { email: 'ada@example.test', accountExists: true, expiresAt: NOW + 1_800_000 };

describe('website access page', () => {
    it('links at once for a signed-in manager with the same address', async () => {
        const app = renderApp({
            path: '/website-access',
            session: MANAGER,
            script: (api) => {
                api.on(apiRoutes.websiteAccessPending, ok(PENDING));
                api.on(apiRoutes.websiteAccessLink, ok({ linked: true as const }));
            },
        });
        expect(await screen.findByRole('heading', { name: 'Linked' })).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.websiteAccessLink)).toHaveLength(1);
        expect(screen.getByRole('link', { name: 'See license' })).toBeTruthy();
        await expectNoAxeViolations(app.container);
    });

    it('refuses another signed-in address without calling the server, and offers to sign out', async () => {
        const app = renderApp({
            path: '/website-access',
            session: MANAGER,
            script: (api) => {
                api.on(apiRoutes.websiteAccessPending, ok({ ...PENDING, email: 'grace@example.test' }));
                api.on(apiRoutes.signout, ok({}));
            },
        });
        expect(await screen.findByRole('heading', { name: 'This is another account' })).toBeTruthy();
        expect(
            screen.getByText(/signed in as ada@example\.test, but ptbk\.io confirmed grace@example\.test/),
        ).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.websiteAccessLink)).toHaveLength(0);
        await app.user.click(screen.getByRole('button', { name: 'Sign out' }));
        await waitFor(() => {
            expect(app.history.location.pathname).toBe('/signin');
        });
        expect(app.history.location.search).toContain('returnTo=%2Fwebsite-access');
    });

    it.each([
        ['email-mismatch', 409, 'This is another account'],
        ['website-link-conflict', 409, 'Already linked elsewhere'],
    ])('explains a %s answer and changes nothing', async (code, status, heading) => {
        renderApp({
            path: '/website-access',
            session: MANAGER,
            script: (api) => {
                api.on(apiRoutes.websiteAccessPending, ok(PENDING));
                api.on(apiRoutes.websiteAccessLink, problem(status, code));
            },
        });
        expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
    });

    it('lets a member see why they cannot link, without trying', async () => {
        const app = renderApp({
            path: '/website-access',
            session: MEMBER,
            script: (api) => api.on(apiRoutes.websiteAccessPending, ok(PENDING)),
        });
        expect(await screen.findByRole('heading', { name: 'Only an owner or admin can link' })).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.websiteAccessLink)).toHaveLength(0);
    });

    it('sends a signed-out person with an account to sign in with a passkey, and back', async () => {
        renderApp({
            path: '/website-access',
            session: null,
            script: (api) => api.on(apiRoutes.websiteAccessPending, ok(PENDING)),
        });
        const signIn = await screen.findByRole('link', { name: 'Sign in with a passkey' });
        expect(signIn.getAttribute('href')).toBe('/signin?returnTo=%2Fwebsite-access');
    });

    it('signs up a new person with the confirmed address, through the App’s own confirmation email', async () => {
        const app = renderApp({
            path: '/website-access',
            session: null,
            script: (api) => {
                api.on(apiRoutes.websiteAccessPending, ok({ ...PENDING, accountExists: false }));
                api.on(apiRoutes.signupStart, ok({ accepted: true as const }));
            },
        });
        expect(await screen.findByRole('heading', { name: 'Create your Promptbook account' })).toBeTruthy();
        const field = screen.getByRole('textbox', { name: /Email/ });
        expect((field as HTMLInputElement).value).toBe('ada@example.test');
        expect((field as HTMLInputElement).readOnly).toBe(true);
        await app.user.click(screen.getByRole('button', { name: 'Send confirmation link' }));
        expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.signupStart)).toEqual([{ body: { email: 'ada@example.test' } }]);
        expect(afterSignUp(app.storage, NOW)).toBe('/website-access');
    });

    it.each([
        [undefined, 'This link has expired'],
        ['expired', 'This link has expired'],
        ['failed', 'ptbk.io couldn’t confirm your account'],
    ])('starts over when nothing is pending (%s)', async (error, heading) => {
        const app = renderApp({
            path: error === undefined ? '/website-access' : `/website-access?error=${error}`,
            session: null,
            script: (api) => api.on(apiRoutes.websiteAccessPending, problem(404, 'not-found')),
        });
        expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
        await app.user.click(screen.getByRole('button', { name: 'Start again' }));
        expect(app.navigations).toEqual(['/api/website-access/start']);
    });
});

describe('website link marker', () => {
    it('returns to the link only until it expires, and survives refused storage', () => {
        const values = new Map<string, string>();
        const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: values.set.bind(values) };
        expect(afterSignUp(storage, NOW)).toBeUndefined();
        rememberWebsiteLink(storage, NOW + 1000);
        expect(afterSignUp(storage, NOW)).toBe('/website-access');
        expect(afterSignUp(storage, NOW + 1000)).toBeUndefined();
        const refusing = {
            getItem: () => {
                throw new Error('denied');
            },
            setItem: () => {
                throw new Error('denied');
            },
        };
        expect(() => {
            rememberWebsiteLink(refusing, NOW);
        }).not.toThrow();
        expect(afterSignUp(refusing, NOW)).toBeUndefined();
    });
});
