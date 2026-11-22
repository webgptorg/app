import { createFormatters } from '@ptbk/ui';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiRoutes, type EngineView, type LinkCodeStatusView, type TeamView } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import {
    billingView,
    ENGINE_DOMAIN,
    ENGINE_ID,
    engineView,
    INSTALL_GUIDE_URL,
    LINK_CODE as CODE,
    LINK_URL,
    linkCodeView as linkCode,
    LINK_CODE_LIFETIME_MS,
    NOW,
    session,
} from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import type { ScriptedApi } from '../../testing/scripted-api';
import { ok, problem } from '../../testing/scripted-api';
import { LINK_POLL_MS, NO_HEARTBEAT_HINT_MS, WAITING_HINT_MS } from './link-progress';

const OWNER = session({ permissions: ['org.read', 'billing.read', 'billing.manage', 'engine.link', 'engine.read'] });
const LINK_ID = 'lllllllllllllllllllllllllq';
const OTHER_LINK_ID = 'mmmmmmmmmmmmmmmmmmmmmmmmmq';
const HOSTNAME = `${ENGINE_ID}.${ENGINE_DOMAIN}`;
const TAB_NAMES = ['Linux server with Docker', 'Docker Compose', 'Already running Promptbook'];
const CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/cs_test_example';

const WAITING_TEXT = 'Waiting for your project to link. Run the command above; this page updates by itself.';
const OWNER_TEXT =
    'Open the first-access link from the installation terminal in the browser where you have App open, then create your passkey. If you installed over SSH, copy the link from your SSH session. To get a new link, run ptbk connect --setup-link on the machine running the project (in the project folder if it already exists). This page updates automatically after you create your passkey.';
const COMMAND_NOTE = `Copy it now: it is shown only once and works until ${createFormatters('en').formatDateTime(new Date(NOW + LINK_CODE_LIFETIME_MS))}.`;

const PENDING: LinkCodeStatusView = { status: 'pending', expiresAt: NOW + LINK_CODE_LIFETIME_MS };
const LINKED: LinkCodeStatusView = {
    status: 'linked',
    engineId: ENGINE_ID as EngineView['engineId'],
    hostname: HOSTNAME as EngineView['hostname'],
};

const READY = engineView();
const NO_HEARTBEAT = engineView({ status: 'never-seen', lastSeenAt: null, heartbeat: null });
const OWNER_PENDING = engineView({
    status: 'owner-pending',
    heartbeat: READY.heartbeat === null ? null : { ...READY.heartbeat, members: 0 },
});

/** The first heartbeats after pairing and after the passkey, of an engine whose setup is still a draft. */
const SETUP_OWNER_PENDING = engineView({
    status: 'owner-pending',
    heartbeat: READY.heartbeat === null ? null : { ...READY.heartbeat, members: 0, setup: 'pending' },
});
const SETUP_PENDING = engineView({
    status: 'setup-pending',
    heartbeat: READY.heartbeat === null ? null : { ...READY.heartbeat, setup: 'pending' },
});

function eligible(eligibility: 'allowed' | 'not-entitled' | 'engine-limit' = 'allowed', linkCodeTtlS = 2_592_000) {
    return (api: ScriptedApi) =>
        api.on(apiRoutes.linkEligibility, ok({ eligibility, linkCodeTtlS, installGuideUrl: INSTALL_GUIDE_URL }));
}

function scriptProgress(api: ScriptedApi, codes: readonly LinkCodeStatusView[], engines: readonly EngineView[]) {
    const lastCode = codes.at(-1);
    if (lastCode !== undefined) {
        api.once(apiRoutes.getLinkCode, ...codes.slice(0, -1).map((code) => ok(code)));
        api.on(apiRoutes.getLinkCode, ok(lastCode));
    }
    const lastEngine = engines.at(-1);
    if (lastEngine !== undefined) {
        api.once(apiRoutes.getEngine, ...engines.slice(0, -1).map((engine) => ok({ engine })));
        api.on(apiRoutes.getEngine, ok({ engine: lastEngine }));
    }
}

/** Eligible, a code issued on load, and the given states of that code and its engine, in order. */
function linking(codes: readonly LinkCodeStatusView[], engines: readonly EngineView[] = []) {
    return (api: ScriptedApi) => {
        eligible()(api);
        api.on(apiRoutes.createLinkCode, ok(linkCode()));
        scriptProgress(api, codes, engines);
    };
}

function progress(): HTMLElement {
    const section = document.querySelector<HTMLElement>('section[data-link-state]');
    if (section === null) throw new Error('no link progress');
    return section;
}

/** Each step's label and whether it is done, current or ahead. */
function steps(): readonly string[] {
    const list = screen.getByRole('list', { name: 'Steps' });
    return within(list)
        .getAllByRole('listitem')
        .map((item) => {
            const where =
                item.getAttribute('aria-current') === 'step'
                    ? 'current'
                    : item.textContent.includes('(done)')
                      ? 'done'
                      : 'ahead';
            return `${item.dataset['step'] ?? ''}:${where}`;
        });
}

function useFakeClock() {
    vi.useFakeTimers({
        shouldAdvanceTime: true,
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.setSystemTime(NOW);
    return { advance: (ms: number) => vi.advanceTimersByTime(ms) };
}

async function elapse(ms: number): Promise<void> {
    await act(() => vi.advanceTimersByTimeAsync(ms));
}

afterEach(() => {
    vi.useRealTimers();
});

describe('new engine page', () => {
    it('sends a signed-out visitor to sign in first', async () => {
        const app = renderApp({ path: '/engines/new' });
        expect(await screen.findByRole('heading', { name: 'Sign in or create an account' })).toBeTruthy();
        expect(app.history.location.pathname).toBe('/continue');
    });

    it('is reachable from the empty engine list', async () => {
        const app = renderApp({ path: '/engines/all', session: OWNER, script: eligible('engine-limit') });
        await app.user.click(await screen.findByRole('link', { name: 'Link a project' }));
        expect(await screen.findByRole('heading', { name: 'Link a project', level: 1 })).toBeTruthy();
        expect(app.history.location.pathname).toBe('/engines/new');
    });

    describe('plan step', () => {
        it('shows the plans before any command, and Checkout returns to this page', async () => {
            const [standard] = billingView().plans;
            if (standard === undefined) throw new Error('a plan');
            const app = renderApp({
                path: '/engines/new',
                session: OWNER,
                script: (api) => {
                    eligible('not-entitled')(api);
                    api.on(apiRoutes.getBilling, ok(billingView({ plans: [{ ...standard, trialDays: 14 }] })));
                    api.on(apiRoutes.billingCheckout, ok({ url: CHECKOUT_URL }));
                },
            });
            expect(await screen.findByRole('heading', { name: 'Choose a plan to link your project' })).toBeTruthy();
            const start = await screen.findByRole('button', { name: 'Start your 14-day trial of Standard' });
            expect(start.textContent).toBe('Start your 14-day trial');
            expect(screen.queryByText(/bun run dev:link/)).toBeNull();
            expect(app.api.callsTo(apiRoutes.createLinkCode)).toEqual([]);
            await expectNoAxeViolations(app.container);
            await app.user.click(start);
            await waitFor(() => {
                expect(app.navigations).toEqual([CHECKOUT_URL]);
            });
            expect(app.api.callsTo(apiRoutes.billingCheckout)).toEqual([
                { body: { planId: 'standard', returnTo: 'engines-new' } },
            ]);
        });

        it('says Checkout was cancelled and offers the plans again', async () => {
            renderApp({
                path: '/engines/new?checkout=cancel',
                session: OWNER,
                script: (api) => {
                    eligible('not-entitled')(api);
                    api.on(apiRoutes.getBilling, ok(billingView()));
                },
            });
            expect(await screen.findByText('Checkout was cancelled. Nothing was charged.')).toBeTruthy();
            expect(await screen.findByRole('button', { name: 'Subscribe to Standard' })).toBeTruthy();
        });

        it('sends someone who cannot manage billing to billing instead', async () => {
            renderApp({
                path: '/engines/new',
                session: session({ permissions: ['org.read', 'engine.link', 'engine.read'] }),
                script: eligible('not-entitled'),
            });
            expect(await screen.findByText('Your plan does not include projects')).toBeTruthy();
            expect(screen.getByRole('link', { name: 'Go to billing' })).toBeTruthy();
        });

        it('shows the engine limit instead of a command', async () => {
            const app = renderApp({ path: '/engines/new', session: OWNER, script: eligible('engine-limit') });
            expect(await screen.findByText("Your plan's project limit is reached")).toBeTruthy();
            expect(screen.getByRole('link', { name: 'Go to billing' })).toBeTruthy();
            expect(app.api.callsTo(apiRoutes.createLinkCode)).toEqual([]);
        });

        it('waits on the return from Checkout until the plan arrives, then issues the code', async () => {
            const fake = useFakeClock();
            const app = renderApp({
                path: '/engines/new?checkout=success',
                session: OWNER,
                fakeTimers: fake,
                script: (api) => {
                    api.once(
                        apiRoutes.linkEligibility,
                        ok({
                            eligibility: 'not-entitled',
                            linkCodeTtlS: 2_592_000,
                            installGuideUrl: INSTALL_GUIDE_URL,
                        }),
                    );
                    eligible()(api);
                    api.on(apiRoutes.getBilling, ok(billingView({ status: 'trialing' })));
                    api.on(apiRoutes.createLinkCode, ok(linkCode()));
                    scriptProgress(api, [PENDING], []);
                },
            });
            expect(await screen.findByText('Thank you. Your plan is starting; this takes a moment.')).toBeTruthy();
            expect(screen.queryByText('Thank you, your trial has started.')).toBeNull();
            expect(screen.queryByRole('heading', { name: 'Choose a plan to link your project' })).toBeNull();
            expect(app.api.callsTo(apiRoutes.createLinkCode)).toEqual([]);
            await elapse(LINK_POLL_MS);
            expect(await screen.findByText(`bun run dev:link ${CODE}`)).toBeTruthy();
            expect(await screen.findByText('Thank you, your trial has started.')).toBeTruthy();
            expect(screen.queryByText('Thank you. Your plan is starting; this takes a moment.')).toBeNull();
            expect(steps()).toEqual(['plan:done', 'install:current', 'connect:ahead', 'finish:ahead']);
            expect(app.api.callsTo(apiRoutes.createLinkCode)).toHaveLength(1);
            // A reload or a bookmark of this address does not thank again.
            await waitFor(() => {
                expect(app.history.location.search).toBe(`?link=${LINK_ID}`);
            });
        });
    });

    describe('with billing off', () => {
        const OFF_OWNER = { ...OWNER, billingEnabled: false };

        it('goes straight to the command, with no plan step and no billing request', async () => {
            const app = renderApp({ path: '/engines/new', session: OFF_OWNER, script: linking([PENDING]) });
            expect(await screen.findByText(`bun run dev:link ${CODE}`)).toBeTruthy();
            expect(steps()).toEqual(['install:current', 'connect:ahead', 'finish:ahead']);
            expect(screen.queryByRole('heading', { name: 'Choose a plan to link your project' })).toBeNull();
            expect(app.api.callsTo(apiRoutes.getBilling)).toEqual([]);
        });

        it.each([
            ['engine-limit', "Your account's project limit is reached", 'Remove a project to link another one.'],
            ['not-entitled', 'Linking projects is not open yet', 'This account cannot link a project at the moment.'],
        ] as const)('says %s without a plan or a way to billing', async (eligibility, title, body) => {
            const app = renderApp({ path: '/engines/new', session: OFF_OWNER, script: eligible(eligibility) });
            expect(await screen.findByText(title)).toBeTruthy();
            expect(screen.getByText(body)).toBeTruthy();
            expect(screen.queryByRole('link', { name: 'Go to billing' })).toBeNull();
            expect(screen.queryByRole('list', { name: 'Steps' })).toBeNull();
            expect(app.api.callsTo(apiRoutes.getBilling)).toEqual([]);
            expect(app.api.callsTo(apiRoutes.createLinkCode)).toEqual([]);
        });

        it('ignores a Checkout return in the address: no thanks, no waiting', async () => {
            const app = renderApp({
                path: '/engines/new?checkout=success',
                session: OFF_OWNER,
                script: linking([PENDING]),
            });
            expect(await screen.findByText(`bun run dev:link ${CODE}`)).toBeTruthy();
            expect(screen.queryByText(/Thank you/)).toBeNull();
            expect(steps()).toEqual(['install:current', 'connect:ahead', 'finish:ahead']);
            expect(app.api.callsTo(apiRoutes.getBilling)).toEqual([]);
        });
    });

    describe('install command', () => {
        it('issues the code on load, once, and keeps only its ID in the URL', async () => {
            const app = renderApp({ path: '/engines/new', session: OWNER, script: linking([PENDING]) });
            expect(await screen.findByText(`bun run dev:link ${CODE}`)).toBeTruthy();
            expect(screen.getByRole('button', { name: 'Copy command' }).textContent).toBe('Copy command');
            expect(screen.getByText(COMMAND_NOTE)).toBeTruthy();
            expect(screen.getByText('Run this on the server that will host Promptbook.')).toBeTruthy();
            expect(screen.queryByText(/grants nothing inside the project/)).toBeNull();
            const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
            expect(within(trail).getByRole('link', { name: 'Projects' }).getAttribute('href')).toBe('/engines');
            expect(within(trail).getByRole('link', { name: 'Projects' }).getAttribute('aria-current')).toBeNull();
            expect(steps()).toEqual(['install:current', 'connect:ahead', 'finish:ahead']);
            await waitFor(() => {
                expect(app.history.location.search).toBe(`?link=${LINK_ID}`);
            });
            expect(app.history.location.href).not.toContain(CODE);
            expect(await within(progress()).findByText(WAITING_TEXT, { selector: 'li p' })).toBeTruthy();
            expect(app.api.callsTo(apiRoutes.createLinkCode)).toHaveLength(1);
            expect(app.api.callsTo(apiRoutes.getLinkCode)[0]).toEqual({ params: { linkCodeId: LINK_ID } });
            await expectNoAxeViolations(app.container);
        });

        it('offers the install paths as tabs in the configured order, the first selected', async () => {
            const app = renderApp({
                path: '/engines/new',
                session: OWNER,
                script: linking([PENDING]),
            });
            const list = await screen.findByRole('tablist', { name: 'How to install' });
            const tabs = within(list).getAllByRole('tab');
            expect(tabs.map((tab) => tab.textContent)).toEqual(TAB_NAMES);
            expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
            const panel = screen.getByRole('tabpanel', { name: 'Linux server with Docker' });
            expect(within(panel).getByText(`bun run dev:link ${CODE}`)).toBeTruthy();
            expect(within(panel).getByText(/It needs outbound HTTPS \(port 443\) and nothing inbound\./)).toBeTruthy();
            expect(
                within(panel)
                    .getByRole('link', { name: /^Requirements and proxies/ })
                    .getAttribute('href'),
            ).toBe(`${INSTALL_GUIDE_URL}#1-the-installer-recommended`);
            expect(within(panel).queryByText(/Moving from an existing Promptbook server/)).toBeNull();

            await app.user.click(within(list).getByRole('tab', { name: 'Already running Promptbook' }));
            const connect = screen.getByRole('tabpanel', { name: 'Already running Promptbook' });
            expect(within(connect).getByText(`ptbk connect --link ${CODE}`)).toBeTruthy();
            expect(within(connect).getByText(/Moving from an existing Promptbook server\?/)).toBeTruthy();
            expect(
                within(connect)
                    .getByRole('link', { name: /^Moving an existing deployment/ })
                    .getAttribute('href'),
            ).toBe(`${INSTALL_GUIDE_URL}#moving-an-existing-deployment`);
            expect(app.api.callsTo(apiRoutes.createLinkCode)).toHaveLength(1);
            await expectNoAxeViolations(app.container);
        });

        it('shows the link URL with its own copy button, outside the tabs', async () => {
            renderApp({ path: '/engines/new', session: OWNER, script: linking([PENDING]) });
            expect(await screen.findByText(LINK_URL)).toBeTruthy();
            expect(screen.getByText("Or give this address to your project's connect command.")).toBeTruthy();
            expect(screen.getByRole('button', { name: 'Copy address' })).toBeTruthy();
            expect(within(screen.getByRole('tabpanel')).queryByText(LINK_URL)).toBeNull();
        });

        it('leaves the link URL out when the dashboard has none (plain-http dev)', async () => {
            renderApp({
                path: '/engines/new',
                session: OWNER,
                script: (api) => {
                    eligible()(api);
                    api.on(apiRoutes.createLinkCode, ok(linkCode({ linkUrl: null })));
                    scriptProgress(api, [PENDING], []);
                },
            });
            expect(await screen.findByText(`bun run dev:link ${CODE}`)).toBeTruthy();
            expect(screen.queryByRole('button', { name: 'Copy address' })).toBeNull();
        });

        it('switches tabs with the keyboard and keeps a multi-line command intact', async () => {
            const app = renderApp({
                path: '/engines/new',
                session: OWNER,
                script: linking([PENDING]),
            });
            const first = await screen.findByRole('tab', { name: 'Linux server with Docker' });
            first.focus();
            await app.user.keyboard('{ArrowRight}');
            const compose = screen.getByRole('tab', { name: 'Docker Compose' });
            expect(document.activeElement).toBe(compose);
            expect(compose.getAttribute('aria-selected')).toBe('true');
            const code = screen.getByRole('tabpanel', { name: 'Docker Compose' }).querySelector('pre code');
            expect(code?.textContent).toBe(linkCode().installCommands[1]?.command);
            expect(code?.textContent).toContain('\n');
            await app.user.keyboard('{End}');
            expect(screen.getByRole('tab', { name: 'Already running Promptbook' }).getAttribute('aria-selected')).toBe(
                'true',
            );
            await app.user.keyboard('{Home}');
            expect(first.getAttribute('aria-selected')).toBe('true');
            await app.user.keyboard('{ArrowLeft}');
            expect(screen.getByRole('tab', { name: 'Already running Promptbook' }).getAttribute('aria-selected')).toBe(
                'true',
            );
        });

        it('copies the command of the selected tab', async () => {
            const app = renderApp({
                path: '/engines/new',
                session: OWNER,
                script: linking([PENDING]),
            });
            // After renderApp: user-event installs its own clipboard stub in setup().
            const writeText = vi.fn(() => Promise.resolve());
            Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
            try {
                for (const [index, name] of TAB_NAMES.entries()) {
                    await app.user.click(await screen.findByRole('tab', { name }));
                    await app.user.click(
                        within(screen.getByRole('tabpanel', { name })).getByRole('button', {
                            name: 'Copy command',
                        }),
                    );
                    expect(writeText).toHaveBeenLastCalledWith(linkCode().installCommands[index]?.command);
                }
                expect(writeText).toHaveBeenCalledTimes(3);
            } finally {
                Reflect.deleteProperty(navigator, 'clipboard');
            }
        });

        it('shows a single configured path without anything the other tabs add', async () => {
            const [installer] = linkCode().installCommands;
            const app = renderApp({
                path: '/engines/new',
                session: OWNER,
                script: (api) => {
                    linking([PENDING])(api);
                    api.on(apiRoutes.createLinkCode, ok(linkCode({ installCommands: installer ? [installer] : [] })));
                },
            });
            expect((await screen.findAllByRole('tab')).map((tab) => tab.textContent)).toEqual([TAB_NAMES[0]]);
            expect(screen.queryByText(/Put the Compose file/)).toBeNull();
            expect(app.container.textContent).not.toMatch(/engines_new_/);
        });

        it('keeps the security explanation behind one link that opens in a new tab, so the command stays', async () => {
            renderApp({ path: '/engines/new', session: OWNER, script: linking([PENDING]) });
            expect(await screen.findByText(`bun run dev:link ${CODE}`)).toBeTruthy();
            const trust = screen.getByRole('link', { name: 'How Promptbook protects you, in a new tab' });
            expect(trust.getAttribute('href')).toBe('/trust');
            expect(trust.getAttribute('target')).toBe('_blank');
            expect(trust.getAttribute('rel')).toBe('noopener');
            expect(screen.queryByText(/grants nothing inside the project/)).toBeNull();
        });

        it('reports the link-code rate limit and offers to try again', async () => {
            const app = renderApp({
                path: '/engines/new',
                session: OWNER,
                script: (api) => {
                    eligible()(api);
                    api.once(apiRoutes.createLinkCode, problem(429, 'rate-limited'));
                    api.on(apiRoutes.createLinkCode, ok(linkCode()));
                    scriptProgress(api, [PENDING], []);
                },
            });
            expect(await screen.findByText('Too many attempts. Wait a minute and try again.')).toBeTruthy();
            expect(screen.queryByRole('link', { name: 'Go to billing' })).toBeNull();
            await app.user.click(await screen.findByRole('button', { name: 'Create link code' }));
            expect(await screen.findByText(`bun run dev:link ${CODE}`)).toBeTruthy();
        });

        it('shows the upgrade path when issuance is refused after all', async () => {
            renderApp({
                path: '/engines/new',
                session: OWNER,
                script: (api) => {
                    eligible()(api);
                    api.on(apiRoutes.createLinkCode, problem(403, 'engine-limit'));
                },
            });
            expect(await screen.findByRole('link', { name: 'Go to billing' })).toBeTruthy();
            expect(screen.queryByText(CODE, { exact: false })).toBeNull();
        });

        it('sends someone at the unused-code limit to Engines to cancel one, without a retry', async () => {
            const app = renderApp({
                path: '/engines/new',
                session: OWNER,
                script: (api) => {
                    eligible()(api);
                    api.on(apiRoutes.createLinkCode, problem(409, 'link-code-limit'));
                },
            });
            expect(await screen.findByText('Too many unused link codes')).toBeTruthy();
            expect(
                screen.getByText('Revoke one you no longer need on Projects, then come back for a new one.'),
            ).toBeTruthy();
            expect(screen.getByRole('link', { name: 'Go to Projects' }).getAttribute('href')).toBe('/engines');
            expect(screen.queryByRole('button', { name: 'Create link code' })).toBeNull();
            expect(app.api.callsTo(apiRoutes.createLinkCode)).toHaveLength(1);
        });

        it('offers a new code once the shown one has expired', async () => {
            const app = renderApp({
                path: '/engines/new',
                session: OWNER,
                script: (api) => {
                    eligible()(api);
                    api.once(apiRoutes.createLinkCode, ok(linkCode({ expiresAt: NOW })));
                    api.on(apiRoutes.createLinkCode, ok(linkCode({ linkCodeId: OTHER_LINK_ID })));
                    scriptProgress(api, [PENDING], []);
                },
            });
            expect(await screen.findByText('The link code expired')).toBeTruthy();
            expect(screen.queryByText(CODE, { exact: false })).toBeNull();
            await app.user.click(screen.getByRole('button', { name: 'Create a new link code' }));
            await waitFor(() => {
                expect(screen.getByText(COMMAND_NOTE)).toBeTruthy();
            });
            expect(app.api.callsTo(apiRoutes.createLinkCode)).toHaveLength(2);
            await waitFor(() => {
                expect(app.history.location.search).toBe(`?link=${OTHER_LINK_ID}`);
            });
        });

        it('explains that only owners link engines', async () => {
            const app = renderApp({ path: '/engines/new', session: session({ permissions: ['org.read'] }) });
            expect(await screen.findByText('Only owners of this organization can link projects.')).toBeTruthy();
            expect(app.api.callsTo(apiRoutes.linkEligibility)).toEqual([]);
            expect(app.api.callsTo(apiRoutes.createLinkCode)).toEqual([]);
        });
    });

    describe('live checklist', () => {
        it('follows the engine from waiting to ready, polling every 3 seconds, and stops there', async () => {
            const fake = useFakeClock();
            const app = renderApp({
                path: '/engines/new',
                session: OWNER,
                fakeTimers: fake,
                script: linking([PENDING, LINKED], [NO_HEARTBEAT, OWNER_PENDING, READY]),
            });
            expect(await screen.findByText(WAITING_TEXT, { selector: 'li p' })).toBeTruthy();
            expect(progress().dataset['linkState']).toBe('waiting');

            await elapse(LINK_POLL_MS);
            expect(await screen.findByText('Project linked.', { selector: 'p.font-medium' })).toBeTruthy();
            expect(progress().dataset['linkState']).toBe('linked');
            expect(screen.queryByText(`bun run dev:link ${CODE}`)).toBeNull();
            expect(screen.queryByText(/shown only once/)).toBeNull();
            expect(steps()).toEqual(['install:done', 'connect:current', 'finish:ahead']);
            expect(screen.getByText(ENGINE_ID.slice(0, 8))).toBeTruthy();
            expect(screen.getByRole('button', { name: `Copy project ID ${ENGINE_ID.slice(0, 8)}` })).toBeTruthy();
            expect(screen.getByText(HOSTNAME)).toBeTruthy();
            expect(
                screen.getByText(
                    'Your terminal shows the same fingerprint. If they differ, this is not your project: revoke it from its page and link yours with a new code.',
                ),
            ).toBeTruthy();
            expect(await screen.findByText("Waiting for the project's first heartbeat.")).toBeTruthy();
            await expectNoAxeViolations(app.container);

            await elapse(LINK_POLL_MS);
            expect(await screen.findByText('Project online, version 1.4.2.', { selector: 'li p' })).toBeTruthy();
            expect(progress().dataset['linkState']).toBe('owner-pending');
            expect(screen.getByText(OWNER_TEXT)).toBeTruthy();
            expect(steps()).toEqual(['install:done', 'connect:done', 'finish:current']);
            expect(screen.queryByRole('link', { name: /^Open project/ })).toBeNull();

            await elapse(LINK_POLL_MS);
            expect(await screen.findByRole('heading', { name: 'Your project is ready', level: 2 })).toBeTruthy();
            expect(steps()).toEqual(['install:done', 'connect:done', 'finish:done']);
            expect(screen.getByText('Setup details').closest('details')?.open).toBe(false);
            expect(progress().dataset['linkState']).toBe('ready');
            expect(screen.getByText('Owner set up.')).toBeTruthy();
            const open = screen.getByRole('link', { name: `Open project ${ENGINE_ID.slice(0, 8)}…, in a new tab` });
            expect(open.getAttribute('href')).toBe(`https://${HOSTNAME}/`);
            expect(open.getAttribute('target')).toBe('_blank');
            expect(open.getAttribute('rel')).toBe('noopener noreferrer');
            expect(open.getAttribute('referrerpolicy')).toBe('no-referrer');
            expect(screen.getByRole('link', { name: 'Back to projects' }).getAttribute('href')).toBe('/engines');
            await expectNoAxeViolations(app.container);

            const calls = app.api.calls.length;
            await elapse(10 * LINK_POLL_MS);
            expect(app.api.calls.length).toBe(calls);
            expect(app.api.callsTo(apiRoutes.getEngine)[0]).toEqual({ params: { engineId: ENGINE_ID } });
        });

        it('ends on Continue setup instead of Open when the engine reports its setup unfinished', async () => {
            const fake = useFakeClock();
            const app = renderApp({
                path: '/engines/new',
                session: OWNER,
                fakeTimers: fake,
                script: linking([LINKED], [SETUP_OWNER_PENDING, SETUP_PENDING, READY]),
            });
            expect(
                await screen.findByText(
                    OWNER_TEXT.replace(
                        'ptbk connect --setup-link',
                        `ptbk connect --onboarding ${ENGINE_ID} --setup-link`,
                    ),
                ),
            ).toBeTruthy();
            expect(screen.queryByRole('link', { name: /^Continue setup/ })).toBeNull();

            await elapse(LINK_POLL_MS);
            expect(await screen.findByRole('heading', { name: 'Your project is connected', level: 2 })).toBeTruthy();
            expect(progress().dataset['linkState']).toBe('ready');
            expect(
                screen.getByText(
                    "Finish setting it up on the project. It keeps what you've done so far, so you can also come back to it later.",
                ),
            ).toBeTruthy();
            expect(progress().querySelector('[aria-live="polite"]')?.textContent).toBe('Your project is connected');
            const link = screen.getByRole('link', {
                name: `Continue setup on project ${ENGINE_ID.slice(0, 8)}…, in a new tab`,
            });
            expect(link.getAttribute('href')).toBe(`https://${HOSTNAME}/`);
            expect(link.getAttribute('rel')).toBe('noopener noreferrer');
            expect(screen.queryByRole('link', { name: /^Open project/ })).toBeNull();
            expect(screen.queryByText('Your project is ready')).toBeNull();
            expect(steps()).toEqual(['install:done', 'connect:done', 'finish:current']);
            await expectNoAxeViolations(app.container);

            await elapse(LINK_POLL_MS);
            expect(await screen.findByRole('heading', { name: 'Your project is ready', level: 2 })).toBeTruthy();
            expect(steps()).toEqual(['install:done', 'connect:done', 'finish:done']);
            expect(screen.getByRole('link', { name: /^Open project/ })).toBeTruthy();
        });

        it('ticks the rows in their order, whichever arrives first, and says how many relays reach it', async () => {
            renderApp({
                path: '/engines/new',
                session: OWNER,
                script: linking([LINKED], [{ ...OWNER_PENDING, reachableRelays: 2 }]),
            });
            const rows = await waitFor(() => {
                const found = [...progress().querySelectorAll<HTMLElement>('[data-step]')];
                expect(found.map((row) => row.dataset['step'])).toEqual(['linked', 'online', 'reachable', 'owner']);
                return found;
            });
            expect(rows.map((row) => row.dataset['stepState'])).toEqual(['done', 'done', 'done', 'current']);
            expect(screen.getByText('Reachable through 2 relays')).toBeTruthy();
        });

        it('says when an online engine is not reachable, with the proxy troubleshooting link', async () => {
            renderApp({
                path: '/engines/new',
                session: OWNER,
                script: linking([LINKED], [{ ...OWNER_PENDING, reachableRelays: 0 }]),
            });
            expect(await screen.findByText('Not reachable: no relay connection')).toBeTruthy();
            const link = screen.getByRole('link', { name: /Troubleshoot proxies and outbound connections/ });
            expect(link.getAttribute('href')).toBe(`${INSTALL_GUIDE_URL}#troubleshooting`);
            expect(document.querySelector('[data-step="reachable"]')?.getAttribute('data-step-state')).toBe('current');
        });

        it('does not call a linked engine unreachable before its first heartbeat', async () => {
            renderApp({
                path: '/engines/new',
                session: OWNER,
                script: linking([LINKED], [{ ...NO_HEARTBEAT, reachableRelays: 0 }]),
            });
            expect(await screen.findByText("Waiting for the project's first heartbeat.")).toBeTruthy();
            expect(document.querySelector('[data-step="reachable"]')).toBeNull();
            expect(screen.queryByText('Not reachable: no relay connection')).toBeNull();
        });

        it('hides the reachability row while no relay reports', async () => {
            renderApp({ path: '/engines/new', session: OWNER, script: linking([LINKED], [OWNER_PENDING]) });
            expect(await screen.findByText(OWNER_TEXT)).toBeTruthy();
            expect(document.querySelector('[data-step="reachable"]')).toBeNull();
        });

        it('points to the troubleshooting guide after 2 minutes of waiting', async () => {
            const fake = useFakeClock();
            renderApp({ path: '/engines/new', session: OWNER, fakeTimers: fake, script: linking([PENDING]) });
            expect(await screen.findByText(WAITING_TEXT, { selector: 'li p' })).toBeTruthy();
            await elapse(WAITING_HINT_MS - 2000);
            expect(screen.queryByText(/^Nothing yet\?/)).toBeNull();
            await elapse(2000);
            expect(
                await screen.findByText('Nothing yet? The project reports problems in the terminal. Common causes:'),
            ).toBeTruthy();
            for (const name of ['No outbound HTTPS', 'A proxy in the way', 'An expired code']) {
                expect(screen.getByRole('link', { name: new RegExp(name) }).getAttribute('href')).toMatch(
                    /#troubleshooting$/,
                );
            }
        });

        it('says so after 3 minutes linked without a heartbeat', async () => {
            const fake = useFakeClock();
            renderApp({
                path: '/engines/new',
                session: OWNER,
                fakeTimers: fake,
                script: linking([LINKED], [NO_HEARTBEAT]),
            });
            expect(await screen.findByText("Waiting for the project's first heartbeat.")).toBeTruthy();
            await elapse(NO_HEARTBEAT_HINT_MS - 2000);
            expect(screen.queryByText(/^Linked, but no heartbeat yet/)).toBeNull();
            await elapse(2000);
            expect(
                await screen.findByText(
                    'Linked, but no heartbeat yet. The project may still be downloading or starting. If the terminal shows an error, it says what to do.',
                ),
            ).toBeTruthy();
        });

        it('announces state changes only, politely', async () => {
            renderApp({ path: '/engines/new', session: OWNER, script: linking([LINKED], [OWNER_PENDING]) });
            await screen.findByText(OWNER_TEXT);
            const live = progress().querySelectorAll('[aria-live="polite"]');
            expect(live).toHaveLength(1);
            expect(live[0]?.textContent).toBe(
                'Project online. Open the first-access link from the installation terminal in the browser where you have App open.',
            );
            expect(document.querySelectorAll('[aria-live="polite"] [data-step]')).toHaveLength(0);
        });

        it('stops at expiry and offers a new code', async () => {
            const fake = useFakeClock();
            const app = renderApp({
                path: `/engines/new?link=${LINK_ID}`,
                session: OWNER,
                fakeTimers: fake,
                script: (api) => {
                    eligible()(api);
                    scriptProgress(api, [PENDING, { status: 'expired' }], []);
                },
            });
            expect(
                await screen.findByText(/^Waiting for your project to link\. This page updates by itself\./),
            ).toBeTruthy();
            await elapse(LINK_POLL_MS);
            expect(await screen.findByText('The link code expired', { selector: 'p.font-semibold' })).toBeTruthy();
            expect(progress().dataset['linkState']).toBe('expired');
            const calls = app.api.callsTo(apiRoutes.getLinkCode).length;
            await elapse(5 * LINK_POLL_MS);
            expect(app.api.callsTo(apiRoutes.getLinkCode)).toHaveLength(calls);
        });

        it('offers a new code after a reload while waiting, since the command is not shown again', async () => {
            const app = renderApp({
                path: `/engines/new?link=${LINK_ID}`,
                session: OWNER,
                script: (api) => {
                    eligible()(api);
                    scriptProgress(api, [PENDING], []);
                    api.on(apiRoutes.createLinkCode, ok(linkCode({ linkCodeId: OTHER_LINK_ID })));
                },
            });
            expect(await screen.findByText("Didn't copy the command?")).toBeTruthy();
            expect(screen.queryByText(CODE, { exact: false })).toBeNull();
            expect(app.api.callsTo(apiRoutes.createLinkCode)).toEqual([]);
            await expectNoAxeViolations(app.container);
            await app.user.click(screen.getByRole('button', { name: 'Create a new link code' }));
            expect(await screen.findByText(`bun run dev:link ${CODE}`)).toBeTruthy();
            await waitFor(() => {
                expect(app.history.location.search).toBe(`?link=${OTHER_LINK_ID}`);
            });
            expect(screen.queryByText("Didn't copy the command?")).toBeNull();
            expect(app.api.callsTo(apiRoutes.createLinkCode)).toHaveLength(1);
        });

        it('resumes after a reload from the link ID, without the command and without a new code', async () => {
            const app = renderApp({
                path: `/engines/new?link=${LINK_ID}`,
                session: OWNER,
                script: (api) => {
                    eligible()(api);
                    scriptProgress(api, [LINKED], [OWNER_PENDING]);
                },
            });
            expect(await screen.findByText(OWNER_TEXT)).toBeTruthy();
            expect(screen.getByText('Project linked.', { selector: 'p.font-medium' })).toBeTruthy();
            expect(screen.queryByRole('heading', { name: 'Install command' })).toBeNull();
            expect(app.api.callsTo(apiRoutes.createLinkCode)).toEqual([]);
            expect(app.api.callsTo(apiRoutes.getLinkCode)).toEqual([{ params: { linkCodeId: LINK_ID } }]);
        });

        it('lets the owner name the linked engine, and the ready step opens it by that name', async () => {
            const label = 'Staging' as NonNullable<EngineView['label']>;
            const app = renderApp({
                path: `/engines/new?link=${LINK_ID}`,
                session: session({ permissions: [...OWNER.activeOrg.permissions, 'engine.rename'] }),
                script: (api) => {
                    eligible()(api);
                    scriptProgress(api, [LINKED], []);
                    api.on(apiRoutes.getEngine, () =>
                        ok({ engine: api.callsTo(apiRoutes.renameEngine).length > 0 ? { ...READY, label } : READY }),
                    );
                    api.on(apiRoutes.renameEngine, ok({ engine: { ...READY, label } }));
                },
            });
            expect(await screen.findByText(/so you can tell your projects apart/)).toBeTruthy();
            // Ready: the panel asks for the name; the collapsed setup details do not ask again.
            expect(screen.getAllByRole('textbox', { name: 'Name' })).toHaveLength(1);
            await app.user.type(screen.getByRole('textbox', { name: 'Name' }), 'Staging');
            await app.user.click(screen.getByRole('button', { name: 'Save name' }));
            expect(await screen.findByText('Name saved')).toBeTruthy();
            expect(app.api.callsTo(apiRoutes.renameEngine)).toEqual([
                { params: { engineId: ENGINE_ID }, body: { label } },
            ]);
            expect(await screen.findByRole('link', { name: 'Open project Staging, in a new tab' })).toBeTruthy();
            await expectNoAxeViolations(app.container);
        });

        it('calls an engine by the name it got at creation, and does not ask for another', async () => {
            const app = renderApp({
                path: `/engines/new?link=${LINK_ID}`,
                session: session({ permissions: [...OWNER.activeOrg.permissions, 'engine.rename', 'team.read'] }),
                script: (api) => {
                    eligible()(api);
                    scriptProgress(api, [LINKED], [READY]);
                    api.on(
                        apiRoutes.listTeams,
                        ok({
                            teams: [
                                {
                                    teamId: 'tttttttttttttttttttttttttt',
                                    name: 'Northwind' as TeamView['name'],
                                    engineId: ENGINE_ID as TeamView['engineId'],
                                    memberCount: 1,
                                    isMember: true,
                                    createdAt: NOW,
                                },
                            ],
                        }),
                    );
                },
            });
            expect(await screen.findByRole('link', { name: 'Open project Northwind, in a new tab' })).toBeTruthy();
            expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
            expect(screen.queryByText(/so you can tell your projects apart/)).toBeNull();
            await expectNoAxeViolations(app.container);
        });

        it('offers no name field without engine.rename', async () => {
            renderApp({
                path: `/engines/new?link=${LINK_ID}`,
                session: OWNER,
                script: (api) => {
                    eligible()(api);
                    scriptProgress(api, [LINKED], [READY]);
                },
            });
            expect(await screen.findByText('Your project is ready', { selector: 'h2' })).toBeTruthy();
            expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
        });

        it('says when the link ID in the URL is not the organization’s', async () => {
            const app = renderApp({
                path: `/engines/new?link=${LINK_ID}`,
                session: OWNER,
                script: (api) => {
                    eligible()(api);
                    api.on(apiRoutes.getLinkCode, problem(404, 'not-found'));
                    api.on(apiRoutes.createLinkCode, ok(linkCode({ linkCodeId: OTHER_LINK_ID })));
                },
            });
            expect(await screen.findByText('This link code is not known here')).toBeTruthy();
            await app.user.click(screen.getByRole('button', { name: 'Create a new link code' }));
            expect(await screen.findByText(`bun run dev:link ${CODE}`)).toBeTruthy();
        });

        it('drops a link parameter that is not a link-code ID', async () => {
            const app = renderApp({
                path: '/engines/new?link=NOT-A-LINK-ID',
                session: OWNER,
                script: linking([PENDING]),
            });
            expect(await screen.findByText(`bun run dev:link ${CODE}`)).toBeTruthy();
            expect(app.api.callsTo(apiRoutes.getLinkCode)[0]).toEqual({ params: { linkCodeId: LINK_ID } });
        });
    });
});
