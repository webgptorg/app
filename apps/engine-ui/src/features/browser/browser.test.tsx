import { DEFAULT_CAPABILITIES } from '@ptbk/engine-api/in-memory';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createFakePopups } from '../../testing/fake-popups';
import { createLiveBrowserTestEngine, createManualDrawer, flushLive } from '../../testing/live-browser-engine';
import type { LiveBrowserTestEngine } from '../../testing/live-browser-engine';
import { renderWithProviders } from '../../testing/render-with-providers';
import type { RenderWithProvidersOptions } from '../../testing/render-with-providers';
import { problemResponse } from '../../testing/test-engine-api';

const SITE = 'https://shop.example';
const OTHER = 'https://elsewhere.example';
const SECRET_TYPING = ['h', 'u', 'n', 't', 'e', 'r', '2'] as const;
const AT = '2026-09-30T10:00:00Z';

function engineWithHelp(options: Parameters<typeof createLiveBrowserTestEngine>[0] = {}) {
    const engine = createLiveBrowserTestEngine(options);
    const tab = engine.controller.openAgentTab({ agentId: 'ada', origin: SITE });
    const help = engine.controller.requestBrowserHelp(tab.id, {
        reason: 'login',
        message: '<img src=x onerror=alert(1)> I hit a login wall at checkout.',
    });
    return { engine, tab, help };
}

function render(engine: LiveBrowserTestEngine, options: RenderWithProvidersOptions = {}) {
    const drawer = createManualDrawer();
    const rendered = renderWithProviders({
        engineApi: engine.client,
        openLiveChannel: engine.openLiveChannel,
        frameDrawer: () => drawer,
        ...options,
    });
    return { ...rendered, drawer };
}

const inputs = (engine: LiveBrowserTestEngine) => engine.sent.filter((message) => message.type === 'input');
const canvas = () =>
    screen.queryByRole('application', { name: /^Live view of the tab/ }) ??
    screen.getByRole('img', { name: /^Live view of the tab/ });

async function takeOverFromHome(engine: LiveBrowserTestEngine, options: RenderWithProvidersOptions = {}) {
    const rendered = render(engine, options);
    const needsYou = await screen.findByRole('region', { name: /^Needs you/ });
    const item = (await within(needsYou).findByText('Ada needs you to sign in')).closest('li');
    if (item === null) throw new Error('no help item');
    await rendered.user.click(within(item).getByRole('button', { name: 'Take over' }));
    await screen.findByRole('heading', { level: 1, name: "Ada's browser" });
    await screen.findByText("You're in control");
    return rendered;
}

describe('the live browser', () => {
    it('shows nothing of it on an engine without browser-tab@1', async () => {
        const engine = createLiveBrowserTestEngine({ capabilities: DEFAULT_CAPABILITIES });
        const listHelp = vi.spyOn(engine.client.browser, 'listHelpRequests');
        const listTabs = vi.spyOn(engine.client.browser, 'listTabs');
        render(engine);
        await screen.findByRole('region', { name: /^Needs you/ });
        await flushLive();
        expect(screen.queryByText(/needs you to sign in/)).toBeNull();
        expect(screen.queryByRole('status', { name: /browser/ })).toBeNull();
        expect(listHelp).not.toHaveBeenCalled();
        expect(listTabs).not.toHaveBeenCalled();
    });

    it('answers a help request in one click after the passkey, then hands the tab back', async () => {
        const { engine, help } = engineWithHelp();
        const control = vi
            .spyOn(engine.client.browser, 'control')
            .mockImplementationOnce(() => problemResponse('step-up-required'));
        const popups = createFakePopups();
        const rendered = render(engine, { popups });
        const needsYou = await screen.findByRole('region', { name: /^Needs you/ });
        const item = (await within(needsYou).findByText('Ada needs you to sign in')).closest('li');
        if (item === null) throw new Error('no help item');
        // The agent's message is model output: text, never markup.
        expect(within(item).getByText(/I hit a login wall at checkout/).textContent).toContain('<img src=x');
        expect(item.querySelector('img')).toBeNull();

        await rendered.user.click(within(item).getByRole('button', { name: 'Take over' }));
        const stepUp = await screen.findByRole('dialog', { name: 'Confirm it is you' });
        await rendered.user.click(within(stepUp).getByRole('button', { name: 'Continue with passkey' }));
        popups.confirm();
        await waitFor(() => {
            expect(control).toHaveBeenCalledTimes(2);
        });
        await screen.findByRole('heading', { level: 1, name: "Ada's browser" });
        expect(await screen.findByText("You're in control")).toBeDefined();
        expect(screen.getByText('on shop.example', { selector: 'span' })).toBeDefined();
        expect(engine.controller.getBrowserTab(help.tabId)?.agentState).toBe('paused');

        fireEvent.keyDown(canvas(), { key: 'Enter' });
        fireEvent.keyUp(canvas(), { key: 'Enter' });
        expect(inputs(engine).map(({ event }) => event)).toEqual([
            { kind: 'key', action: 'down', key: 'Enter', shift: false },
            { kind: 'key', action: 'up', key: 'Enter', shift: false },
        ]);

        await rendered.router.navigate({ to: '/' });
        const bar = (await screen.findByText("You're controlling the agent's browser on shop.example")).closest(
            '[role="status"]',
        );
        if (!(bar instanceof HTMLElement)) throw new Error('no indicator');
        await rendered.user.click(within(bar).getByRole('link', { name: 'Open' }));
        await rendered.user.click(await screen.findByRole('button', { name: 'Hand back to agent' }));
        expect(await screen.findByText('Watching')).toBeDefined();
        expect(engine.controller.getBrowserTab(help.tabId)?.agentState).toBe('working');
        const resolved = await engine.client.browser.getHelpRequest(help.id, AbortSignal.timeout(1_000));
        expect(resolved.kind === 'ok' && resolved.data.resolution?.outcome).toBe('handed-back');
        fireEvent.keyDown(canvas(), { key: 'a' });
        expect(inputs(engine)).toHaveLength(2);
    });

    it('watches a run’s tab read-only and sends no input', async () => {
        const engine = createLiveBrowserTestEngine({
            seed: {
                agents: [{ id: 'ada', source: 'Ada\nPERSONA Research' }],
                runs: [
                    {
                        id: 'run-shop',
                        agentId: 'ada',
                        source: 'member',
                        status: 'running',
                        chatId: null,
                        messageId: null,
                        triggerId: null,
                        retryOf: null,
                        createdBy: 'member-owner',
                        queuedAt: AT,
                        startedAt: AT,
                        completedAt: null,
                        cancelRequestedAt: null,
                        attemptCount: 1,
                        runner: 'claude-code',
                        model: null,
                        progress: { title: 'Buy the parts', now: 'Comparing prices', next: null, items: [] },
                        usage: null,
                        error: null,
                        preview: null,
                        toolCalls: [],
                        outputs: { messages: [], files: [], projectChanges: [] },
                        report: { touchedProjects: [], externalSources: [] },
                    },
                ],
            },
        });
        engine.controller.openAgentTab({ agentId: 'ada', runId: 'run-shop', origin: SITE });
        const { user, drawer } = render(engine, { path: '/runs/run-shop' });
        const tabs = await screen.findByRole('list', { name: "Agent's browser" });
        expect(within(tabs).getByText('Working')).toBeDefined();
        await user.click(within(tabs).getByRole('button', { name: 'Watch' }));
        expect(await screen.findByText('Watching')).toBeDefined();
        expect(await screen.findByText('Now: Comparing prices')).toBeDefined();
        expect(screen.getByRole('img', { name: 'Live view of the tab on shop.example' })).toBeDefined();
        expect(screen.getByText(/Nothing you do here reaches the tab/)).toBeDefined();

        await waitFor(() => {
            expect(drawer.waiting()).toBe(1);
        });
        drawer.release();
        await waitFor(() => {
            expect(engine.sent.some((message) => message.type === 'frame-ack' && message.seq === 2)).toBe(true);
        });
        expect(drawer.drawn).toEqual([2]);

        fireEvent.keyDown(canvas(), { key: 'a' });
        fireEvent.pointerDown(canvas(), { button: 0, clientX: 10, clientY: 10 });
        fireEvent.wheel(canvas(), { deltaY: 100 });
        await flushLive();
        expect(inputs(engine)).toEqual([]);
    });

    it('forwards pointer, wheel and keys in tab coordinates, never shortcuts, and keeps no typed text', async () => {
        const { engine } = engineWithHelp();
        const rendered = await takeOverFromHome(engine);
        const screenBox = { left: 100, top: 50, width: 640, height: 400, right: 740, bottom: 450, x: 100, y: 50 };
        vi.spyOn(canvas(), 'getBoundingClientRect').mockReturnValue({ ...screenBox, toJSON: () => screenBox });
        fireEvent.pointerDown(canvas(), { button: 0, buttons: 1, clientX: 420, clientY: 250, pointerId: 1 });
        fireEvent.pointerUp(canvas(), { button: 0, clientX: 420, clientY: 250, pointerId: 1 });
        fireEvent.pointerDown(canvas(), { button: 0, buttons: 1, clientX: 420, clientY: 250, pointerId: 1 });
        fireEvent.pointerDown(canvas(), { button: 3, clientX: 420, clientY: 250 });
        fireEvent.wheel(canvas(), { deltaY: 3, deltaMode: 1, clientX: 740, clientY: 450 });
        fireEvent.pointerMove(canvas(), { buttons: 1, clientX: 900, clientY: 10 });
        await waitFor(() => {
            expect(inputs(engine).some(({ event }) => event.kind === 'pointer' && event.action === 'move')).toBe(true);
        });
        canvas().focus();
        for (const key of SECRET_TYPING) fireEvent.keyDown(canvas(), { key });
        fireEvent.keyDown(canvas(), { key: 'v', metaKey: true });
        fireEvent.keyDown(canvas(), { key: 'c', ctrlKey: true });
        fireEvent.keyDown(canvas(), { key: 'F12' });
        fireEvent.keyDown(canvas(), { key: 'Shift', shiftKey: true });
        fireEvent.keyDown(canvas(), { key: 'A', shiftKey: true });
        fireEvent.contextMenu(canvas());

        const events = inputs(engine).map(({ event }) => event);
        expect(events.slice(0, 4)).toEqual([
            { kind: 'pointer', action: 'down', x: 640, y: 400, button: 'left', clicks: 1 },
            { kind: 'pointer', action: 'up', x: 640, y: 400, button: 'left', clicks: 1 },
            { kind: 'pointer', action: 'down', x: 640, y: 400, button: 'left', clicks: 2 },
            { kind: 'wheel', x: 1280, y: 800, deltaX: 0, deltaY: 48 },
        ]);
        expect(events).toContainEqual({ kind: 'pointer', action: 'move', x: 1280, y: 0, button: 'left', clicks: 0 });
        const keys = events.flatMap((event) => (event.kind === 'key' ? [event.key] : []));
        expect(keys).toEqual([...SECRET_TYPING, 'A']);

        // What the member typed lives in no query or mutation, nor in the engine's audit log.
        const cached = JSON.stringify([
            rendered.queryClient
                .getQueryCache()
                .getAll()
                .map((query) => query.state.data),
            rendered.queryClient
                .getMutationCache()
                .getAll()
                .map((mutation) => mutation.state.variables),
        ]);
        expect(cached).not.toContain('"key"');
        expect(cached).not.toMatch(/h.?u.?n.?t.?e.?r/);

        fireEvent.keyDown(canvas(), { key: 'Escape', shiftKey: true });
        expect(document.activeElement).not.toBe(canvas());
    });

    it('shows a blocked origin and sends nothing until the tab is back', async () => {
        const { engine, tab } = engineWithHelp();
        await takeOverFromHome(engine);
        engine.controller.navigateBrowserTab(tab.id, { kind: 'web', origin: OTHER });
        expect(await screen.findByText('Page hidden')).toBeDefined();
        expect(screen.getByText(/The tab went to elsewhere\.example, which this session can't show/)).toBeDefined();
        fireEvent.keyDown(canvas(), { key: 'a' });
        expect(inputs(engine)).toEqual([]);

        engine.controller.navigateBrowserTab(tab.id, { kind: 'secret-page' });
        expect(await screen.findByText(/a page with secrets, which is never shown/)).toBeDefined();
        engine.controller.navigateBrowserTab(tab.id, { kind: 'browser-page' });
        expect(await screen.findByText(/a page of the browser itself/)).toBeDefined();

        engine.controller.navigateBrowserTab(tab.id, { kind: 'web', origin: SITE });
        expect(await screen.findByText("You're in control")).toBeDefined();
        fireEvent.keyDown(canvas(), { key: 'a' });
        expect(inputs(engine)).toHaveLength(1);
    });

    it.each([
        ['expired', 'The session reached its 10-minute limit.'],
        ['idle', 'The session ended after 2 minutes without input. The agent has the tab again.'],
    ] as const)('says why the session ended: %s', async (what, text) => {
        const { engine } = engineWithHelp();
        const { router } = await takeOverFromHome(engine);
        const sessionId = router.state.location.pathname.split('/').at(-1) ?? '';
        expect(engine.controller.elapseBrowserSession(sessionId, what)).toBe(true);
        expect(await screen.findByText(text)).toBeDefined();
        expect(screen.getByText('Ended')).toBeDefined();
        expect(screen.queryByText(/You're controlling the agent's browser/)).toBeNull();
        expect(screen.queryByRole('button', { name: 'Hand back to agent' })).toBeNull();
    });

    it('says when the agent closed the tab, and watches again on request', async () => {
        const { engine, tab } = engineWithHelp();
        const { user } = await takeOverFromHome(engine);
        engine.controller.closeAgentTab(tab.id);
        expect(await screen.findByText('The agent closed the tab.')).toBeDefined();
        const again = vi
            .spyOn(engine.client.browser, 'watch')
            .mockImplementationOnce(() => problemResponse('browser-tab-full'));
        await user.click(screen.getByRole('button', { name: 'Watch again' }));
        expect(await screen.findByText(/Too many people are in this tab/)).toBeDefined();
        expect(again).toHaveBeenCalledOnce();
    });

    it('keeps an indicator in the shell while the session is live, and ends it from there', async () => {
        const { engine, tab } = engineWithHelp();
        const { router, user } = await takeOverFromHome(engine);
        await router.navigate({ to: '/' });
        const bar = (await screen.findByText("You're controlling the agent's browser on shop.example")).closest(
            '[role="status"]',
        );
        if (!(bar instanceof HTMLElement)) throw new Error('no indicator');
        // Away from the viewer, frames pause.
        await waitFor(() => {
            expect(engine.sent.at(-1)).toMatchObject({ type: 'view', visible: false });
        });
        await user.click(within(bar).getByRole('link', { name: 'Open' }));
        await screen.findByRole('heading', { level: 1, name: "Ada's browser" });
        await router.navigate({ to: '/' });
        const again = (await screen.findByText(/You're controlling the agent's browser/)).closest('[role="status"]');
        if (!(again instanceof HTMLElement)) throw new Error('no indicator');
        await user.click(within(again).getByRole('button', { name: 'End' }));
        await waitFor(() => {
            expect(screen.queryByText(/You're controlling the agent's browser/)).toBeNull();
        });
        expect(engine.controller.getBrowserTab(tab.id)?.agentState).toBe('working');
    });

    it('ends the session from the overflow menu', async () => {
        const { engine, tab } = engineWithHelp();
        const { user } = await takeOverFromHome(engine);
        await user.click(screen.getByRole('button', { name: 'More browser actions' }));
        await user.click(await screen.findByRole('menuitem', { name: 'End session' }));
        expect(await screen.findByText('The session ended.')).toBeDefined();
        expect(engine.controller.getBrowserTab(tab.id)?.participants).toBe(0);
    });

    it('reattaches to a session after a reload and takes control after the passkey', async () => {
        const engine = createLiveBrowserTestEngine();
        const tab = engine.controller.openAgentTab({ agentId: 'ada', origin: SITE });
        const take = vi
            .spyOn(engine.client.browser, 'takeControl')
            .mockImplementationOnce(() => problemResponse('step-up-required'));
        const opened = await engine.client.browser.watch(tab.id, AbortSignal.timeout(1_000));
        if (opened.kind !== 'ok') throw new Error('not opened');
        const popups = createFakePopups();
        const { user } = render(engine, { path: `/browser/${opened.data.id}`, popups });
        expect(await screen.findByText('Watching')).toBeDefined();
        await user.click(await screen.findByRole('button', { name: 'Take control' }));
        const stepUp = await screen.findByRole('dialog', { name: 'Confirm it is you' });
        await user.click(within(stepUp).getByRole('button', { name: 'Continue with passkey' }));
        popups.confirm();
        await waitFor(() => {
            expect(take).toHaveBeenCalledTimes(2);
        });
        expect(await screen.findByText("You're in control")).toBeDefined();
        expect(engine.controller.getBrowserTab(tab.id)?.agentState).toBe('paused');
    });

    it('says when a session is not this sign-in’s', async () => {
        const engine = createLiveBrowserTestEngine();
        render(engine, { path: '/browser/live-missing' });
        expect(await screen.findByText(/This browser session isn't available/)).toBeDefined();
    });

    it('dismisses a help request from its overflow menu', async () => {
        const { engine, help } = engineWithHelp();
        const { user } = render(engine);
        const needsYou = await screen.findByRole('region', { name: /^Needs you/ });
        await within(needsYou).findByText('Ada needs you to sign in');
        await user.click(within(needsYou).getByRole('button', { name: 'Help request actions' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Dismiss' }));
        expect(await screen.findByText(/Dismissed\. The agent goes on without your help/)).toBeDefined();
        await waitFor(() => {
            expect(screen.queryByText('Ada needs you to sign in')).toBeNull();
        });
        const resolved = await engine.client.browser.getHelpRequest(help.id, AbortSignal.timeout(1_000));
        expect(resolved.kind === 'ok' && resolved.data.resolution?.outcome).toBe('dismissed');
    });

    it('lets a member without control watch a help request but not take it over', async () => {
        const { engine } = engineWithHelp({
            member: {
                permissions: ['browser.watch', 'agents.read', 'chats.read', 'runs.read', 'tasks.read'],
                role: 'member',
            },
        });
        const { user } = render(engine);
        const needsYou = await screen.findByRole('region', { name: /^Needs you/ });
        const item = (await within(needsYou).findByText('Ada needs you to sign in')).closest('li');
        if (item === null) throw new Error('no help item');
        expect(within(item).queryByRole('button', { name: 'Take over' })).toBeNull();
        expect(within(item).queryByRole('button', { name: 'Help request actions' })).toBeNull();
        await user.click(within(item).getByRole('button', { name: 'Watch' }));
        expect(await screen.findByText('Agent waiting for help')).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Take control' })).toBeNull();
    });

    it('opens a sign-in tab from a Wallet login and ends it when done', async () => {
        const engine = createLiveBrowserTestEngine({
            seed: {
                wallet: {
                    records: [
                        {
                            id: 'login-github',
                            label: 'github.com',
                            origin: 'https://github.com',
                            username: 'ada@example.com',
                            fields: [],
                            updatedAt: AT,
                            lastUse: null,
                            verification: null,
                        },
                    ],
                },
            },
        });
        const { user, router } = render(engine, { path: '/wallet' });
        const logins = await screen.findByRole('region', { name: 'Saved logins' });
        await user.click(await within(logins).findByRole('button', { name: /^More for github\.com/ }));
        await user.click(await screen.findByRole('menuitem', { name: "Sign in in the engine's browser" }));
        expect(await screen.findByRole('heading', { level: 1, name: 'Sign in on github.com' })).toBeDefined();
        expect(await screen.findByText(/Your clicks and keys go to the site/)).toBeDefined();
        await router.navigate({ to: '/wallet' });
        expect(await screen.findByText("You're signing in on github.com in the engine's browser")).toBeDefined();
        router.history.back();
        await user.click(await screen.findByRole('button', { name: 'Done' }));
        expect(await screen.findByText('The session ended.')).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Watch again' })).toBeNull();
    });

    it('reconnects within the session after the channel drops', async () => {
        const { engine } = engineWithHelp();
        await takeOverFromHome(engine);
        engine.drop();
        expect(await screen.findByText('Reconnecting')).toBeDefined();
        expect(await screen.findByText("You're in control", {}, { timeout: 3_000 })).toBeDefined();
        expect(engine.channels()).toBe(2);
    });
});
