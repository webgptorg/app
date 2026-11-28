import { describe, expect, it } from 'vitest';

import { KNOWN_CAPABILITIES } from '../capabilities/capability';
import {
    BROWSER_IDLE_MS,
    BrowserHelpRequest,
    BrowserSession,
    LIVE_SESSION_ATTACH_MS,
    MAX_BROWSER_PARTICIPANTS,
    MAX_BROWSER_TAB_SESSION_MS,
} from '../capabilities/live';
import { LiveEngineMessage, MAX_LIVE_INPUT_PER_S, decodeLiveMedia } from '../capabilities/live-channel';
import type { LiveInputEvent, LiveMedia } from '../capabilities/live-channel';
import type { EngineApiResponse } from '../client';
import type { EngineEvent } from '../events';
import { DEFAULT_CAPABILITIES, createInMemoryEngineCore } from '../in-memory-client';
import type { InMemoryEngineCoreOptions } from '../in-memory-client';
import { OWNER_PERMISSIONS } from '../permissions';
import type { Permission } from '../permissions';
import { ENGINE_API_ROUTES as R } from '../routes';
import type { RouteDefinition } from '../route';
import type { Actor } from './kit';
import { FAKE_VIEWPORT } from './live';
import type { LiveChannelPeer } from './live';

const START = Date.parse('2026-11-20T10:00:00Z');
const SITE = 'https://shop.example';
const OTHER = 'https://elsewhere.example';
const WATCH: readonly Permission[] = ['browser.watch', 'chats.read', 'runs.read', 'tasks.read', 'agents.read'];
const CLIENT = { ip: '192.0.2.1', userAgent: 'test' } as const;

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`expected ok, got ${response.problem.code}`);
    return response.data;
}

function code(response: EngineApiResponse<unknown>): string {
    return response.kind === 'problem' ? response.problem.code : 'ok';
}

interface Viewer {
    readonly peer: LiveChannelPeer;
    readonly messages: LiveEngineMessage[];
    readonly frames: LiveMedia[];
    closed: number | null;
    send(message: unknown): void;
    types(): string[];
    input(event: LiveInputEvent): void;
}

function setup(options: InMemoryEngineCoreOptions = {}) {
    let now = START;
    const core = createInMemoryEngineCore({
        clock: { now: () => new Date(now) },
        capabilities: [...DEFAULT_CAPABILITIES, KNOWN_CAPABILITIES.browserTab],
        ...options,
    });
    const events: EngineEvent[] = [];
    core.controller.onEvent((event) => events.push(event));
    const at = new Date(START).toISOString();
    const signIn = (memberId: string, sessionId: string): void => {
        if (!core.controller.inspect().members.some(({ id }) => id === memberId)) {
            core.controller.addMember({
                id: memberId,
                displayName: memberId,
                role: 'member',
                status: 'active',
                createdAt: at,
                lastSeenAt: null,
            });
        }
        core.controller.addSession({
            id: sessionId,
            memberId,
            client: CLIENT,
            createdAt: at,
            lastSeenAt: at,
            expiresAt: new Date(START + 86_400_000).toISOString(),
        });
    };
    const actor = (
        memberId: string,
        sessionId: string,
        permissions: readonly Permission[],
        stepUpFresh = true,
    ): Actor =>
        ({
            memberId,
            sessionId,
            client: CLIENT,
            permissions: new Set(permissions),
            stepUpFresh,
        }) as unknown as Actor;
    signIn('member-owner', 'session-laptop');
    signIn('member-watcher', 'session-watcher');
    const owner = actor('member-owner', 'session-current', OWNER_PERMISSIONS);
    const ownerLaptop = actor('member-owner', 'session-laptop', OWNER_PERMISSIONS);
    const watcher = actor('member-watcher', 'session-watcher', WATCH);
    const call = (who: Actor, route: RouteDefinition, request: object = {}) =>
        core.transport(who)(route, request, AbortSignal.timeout(5_000)) as Promise<EngineApiResponse<never>>;
    const attach = (who: Actor, sessionId: string): Viewer => {
        const viewer = {
            messages: [] as LiveEngineMessage[],
            frames: [] as LiveMedia[],
            closed: null as number | null,
        };
        const result = core.attachLiveChannel(who, sessionId, {
            send: (data) => {
                if (typeof data === 'string') {
                    viewer.messages.push(LiveEngineMessage.parse(JSON.parse(data)));
                    return;
                }
                const decoded = decodeLiveMedia(data);
                if (decoded.kind !== 'ok') throw new Error('engine sent bad media');
                viewer.frames.push(decoded.media);
            },
            close: (closeCode) => {
                viewer.closed = closeCode;
            },
        });
        if (result.kind !== 'attached') throw new Error(`refused: ${result.problem.code}`);
        const peer = result.peer;
        peer.opened();
        return Object.assign(viewer, {
            peer,
            send: (message: unknown) => {
                peer.receive(JSON.stringify(message));
            },
            types: () => viewer.messages.map(({ type }) => type),
            input: (event: LiveInputEvent) => {
                peer.receive(JSON.stringify({ type: 'input', event }));
            },
        });
    };
    const join = (who: Actor, sessionId: string): Viewer => {
        const viewer = attach(who, sessionId);
        viewer.send({ type: 'hello', versions: [1] });
        return viewer;
    };
    const advance = (ms: number): void => {
        now += ms;
    };
    const agentTab = (origin = SITE) =>
        core.controller.openAgentTab({ agentId: 'agent-1', chatId: 'chat-1', runId: 'run-1', origin });
    return { core, events, owner, ownerLaptop, watcher, actor, signIn, call, attach, join, advance, agentTab };
}

type World = ReturnType<typeof setup>;

async function watch(world: World, who = world.watcher, tabId = world.agentTab().id): Promise<BrowserSession> {
    return BrowserSession.parse(ok(await world.call(who, R.watchBrowserTab, { params: { tabId } })));
}

async function control(world: World, tabId: string, who = world.owner): Promise<BrowserSession> {
    return BrowserSession.parse(ok(await world.call(who, R.controlBrowserTab, { params: { tabId } })));
}

const click = { kind: 'pointer', action: 'down', x: 100, y: 100, button: 'left', clicks: 1 } as const;

describe('sign-in sessions', () => {
    it('binds a Wallet-only session to the current request, origin and owner', async () => {
        const world = setup({ capabilities: [...DEFAULT_CAPABILITIES, KNOWN_CAPABILITIES.walletSignIn] });
        const request = world.core.controller.requestWalletLogin({
            origin: SITE,
            account: 'ada@example.test',
            problem: 'rejected',
            fields: [],
            recordId: null,
            reason: 'Sign in to publish.',
            tasks: ['Publish'],
            agents: ['Ada'],
        });
        const target = { kind: 'request', id: request.id, step: request.step };
        const open = (wallet?: object, origin = SITE, member = world.owner) =>
            world.call(member, R.openBrowserSignIn, { body: { browser: null, origin, wallet } });
        expect(code(await open())).toBe('browser-origin-refused');
        expect(code(await open({ kind: 'record', id: 'missing' }))).toBe('not-found');
        expect(code(await open({ ...target, step: request.step + 1 }))).toBe('wallet-request-moved');
        expect(code(await open(target, 'https://other.example'))).toBe('browser-origin-refused');
        expect(code(await open(target, SITE, world.watcher))).toBe('forbidden');
        const session = BrowserSession.parse(ok(await open(target)));
        expect(
            code(await world.call(world.ownerLaptop, R.getBrowserSession, { params: { sessionId: session.id } })),
        ).toBe('not-found');
        expect(code(await world.call(world.owner, R.listBrowserTabs))).toBe('capability-not-supported');
        world.core.controller.navigateBrowserTab(session.tabId, { kind: 'web', origin: 'https://other.example' });
        expect(code(await world.call(world.owner, R.handBackBrowserTab, { params: { sessionId: session.id } }))).toBe(
            'wallet-sign-in-incomplete',
        );
        expect(
            BrowserSession.parse(
                ok(await world.call(world.owner, R.getBrowserSession, { params: { sessionId: session.id } })),
            ).status,
        ).toBe('open');
    });

    it('open only at an allowlisted origin, never the engine’s own, one at a time', async () => {
        const world = setup();
        const open = (origin: string, browser: string | null = null) =>
            world.call(world.owner, R.openBrowserSignIn, { body: { browser, origin } });
        expect(code(await open(SITE))).toBe('browser-origin-refused');
        world.core.controller.setBrowserSignInOrigins([SITE, 'https://memoryengine234567abcdefgh.engine.test']);
        world.core.controller.updateEngine({ hostname: 'memoryengine234567abcdefgh.engine.test' });
        expect(code(await open('https://memoryengine234567abcdefgh.engine.test'))).toBe('browser-origin-refused');
        expect(code(await open(SITE, 'work'))).toBe('validation-failed');
        const session = BrowserSession.parse(ok(await open(SITE, 'default')));
        expect(session).toMatchObject({ kind: 'sign-in', mode: 'controlling', origin: SITE, status: 'open' });
        expect(Date.parse(session.attachBy) - START).toBe(LIVE_SESSION_ATTACH_MS);
        expect(Date.parse(session.endsAt) - START).toBe(MAX_BROWSER_TAB_SESSION_MS);
        expect(code(await open(SITE))).toBe('browser-busy');
        expect(ok(await world.call(world.owner, R.listBrowserTabs, { query: {} }))).toEqual({ items: [] });
        expect(code(await world.call(world.owner, R.watchBrowserTab, { params: { tabId: session.tabId } }))).toBe(
            'not-found',
        );
    });

    it('take the Wallet’s origins as allowed', async () => {
        const world = setup();
        world.core.controller.requestWalletLogin({
            origin: SITE,
            account: null,
            problem: 'missing',
            reason: 'x',
            tasks: [],
            agents: [],
            fields: [],
            recordId: null,
        });
        const session = ok(
            await world.call(world.owner, R.openBrowserSignIn, { body: { browser: null, origin: SITE } }),
        );
        expect(session).toMatchObject({ origin: SITE });
    });

    it('need step-up and browser.control', async () => {
        const world = setup();
        world.core.controller.setBrowserSignInOrigins([SITE]);
        const body = { body: { browser: null, origin: SITE } };
        const stale = world.actor('member-owner', 'session-current', OWNER_PERMISSIONS, false);
        expect(code(await world.call(stale, R.openBrowserSignIn, body))).toBe('step-up-required');
        expect(code(await world.call(world.watcher, R.openBrowserSignIn, body))).toBe('forbidden');
    });

    it('end by handing back, closing the tab so a new one may open', async () => {
        const world = setup();
        world.core.controller.setBrowserSignInOrigins([SITE]);
        const body = { body: { browser: null, origin: SITE } };
        const session = BrowserSession.parse(ok(await world.call(world.owner, R.openBrowserSignIn, body)));
        const viewer = world.join(world.owner, session.id);
        const ended = ok(await world.call(world.owner, R.handBackBrowserTab, { params: { sessionId: session.id } }));
        expect(ended).toMatchObject({ status: 'ended', endReason: 'ended', origin: null });
        expect(viewer.messages.at(-1)).toEqual({ type: 'end', reason: 'ended' });
        expect(viewer.closed).toBe(1000);
        expect(code(await world.call(world.owner, R.openBrowserSignIn, body))).toBe('ok');
    });

    it('stop frames and drop input when the tab leaves the origin', async () => {
        const world = setup();
        world.core.controller.setBrowserSignInOrigins([SITE]);
        const session = BrowserSession.parse(
            ok(await world.call(world.owner, R.openBrowserSignIn, { body: { browser: null, origin: SITE } })),
        );
        const viewer = world.join(world.owner, session.id);
        world.core.controller.navigateBrowserTab(session.tabId, {
            kind: 'web',
            origin: 'https://accounts.idp.example',
        });
        expect(viewer.messages.at(-1)).toEqual({
            type: 'blocked',
            reason: 'origin-not-allowed',
            origin: 'https://accounts.idp.example',
        });
        const frames = viewer.frames.length;
        viewer.send({ type: 'frame-ack', seq: viewer.frames.at(-1)?.seq });
        world.core.controller.browserTick();
        viewer.input(click);
        expect(viewer.frames).toHaveLength(frames);
        expect(viewer.messages.at(-1)).toEqual({ type: 'input-refused', reason: 'blocked' });
        expect(
            ok(await world.call(world.owner, R.getBrowserSession, { params: { sessionId: session.id } })),
        ).toMatchObject({
            origin: null,
        });
        world.core.controller.navigateBrowserTab(session.tabId, { kind: 'web', origin: SITE });
        expect(viewer.messages.at(-1)).toEqual({ type: 'navigated', origin: SITE });
        expect(viewer.frames.length).toBeGreaterThan(frames);
    });
});

describe('agent tabs', () => {
    it('are listed to members who may watch the work, filtered by its links', async () => {
        const world = setup();
        const tab = world.agentTab();
        world.core.controller.openAgentTab({ chatId: 'chat-2', origin: OTHER });
        const listed = ok(await world.call(world.watcher, R.listBrowserTabs, { query: { chatId: 'chat-1' } }));
        expect(listed).toEqual({ items: [tab] });
        expect(
            ok(await world.call(world.watcher, R.listBrowserTabs, { query: { runId: 'run-9', taskId: 'task-1' } })),
        ).toEqual({ items: [] });
        const blind = world.actor('member-watcher', 'session-watcher', ['browser.watch']);
        expect(ok(await world.call(blind, R.listBrowserTabs, { query: {} }))).toEqual({ items: [] });
        expect(code(await world.call(blind, R.watchBrowserTab, { params: { tabId: tab.id } }))).toBe('not-found');
        const none = world.actor('member-watcher', 'session-watcher', ['chats.read']);
        expect(code(await world.call(none, R.listBrowserTabs, { query: {} }))).toBe('forbidden');
        expect(world.core.controller.getBrowserTab(tab.id)).toEqual(tab);
        expect(world.events).toContainEqual({ type: 'browser-tab.changed', tabId: tab.id });
    });

    it('cap their watchers one place short, so watching never locks an owner out of control', async () => {
        const world = setup();
        const tab = world.agentTab();
        for (let index = 0; index < MAX_BROWSER_PARTICIPANTS - 1; index++) await watch(world, world.watcher, tab.id);
        expect(code(await world.call(world.watcher, R.watchBrowserTab, { params: { tabId: tab.id } }))).toBe(
            'browser-tab-full',
        );
        await control(world, tab.id);
        expect(world.core.controller.getBrowserTab(tab.id)).toMatchObject({
            participants: MAX_BROWSER_PARTICIPANTS,
            agentState: 'paused',
        });
    });
});

describe('the channel', () => {
    it('attaches only for the gateway session that opened the session, once at a time', async () => {
        const world = setup();
        const session = await watch(world);
        expect(
            world.core.attachLiveChannel(world.ownerLaptop, session.id, {
                send: () => undefined,
                close: () => undefined,
            }),
        ).toMatchObject({
            kind: 'refused',
            problem: { code: 'not-found' },
        });
        expect(
            code(await world.call(world.ownerLaptop, R.getBrowserSession, { params: { sessionId: session.id } })),
        ).toBe('not-found');
        const first = world.attach(world.watcher, session.id);
        expect(
            world.core.attachLiveChannel(world.watcher, session.id, { send: () => undefined, close: () => undefined }),
        ).toMatchObject({ kind: 'refused', problem: { code: 'live-channel-attached' } });
        first.peer.closed();
        first.peer.receive('{"type":"end"}');
        const again = world.join(world.watcher, session.id);
        expect(again.types()).toEqual(['hello', 'state', 'navigated']);
    });

    it('refuses without the capability, a member, or a browser permission', () => {
        const world = setup({ capabilities: DEFAULT_CAPABILITIES });
        const sink = { send: () => undefined, close: () => undefined };
        expect(world.core.attachLiveChannel(world.owner, 'live-1', sink)).toMatchObject({
            problem: { code: 'capability-not-supported' },
        });
        const live = setup();
        const ghost = live.actor('member-ghost', 'session-ghost', WATCH);
        expect(live.core.attachLiveChannel(ghost, 'live-1', sink)).toMatchObject({
            problem: { code: 'unauthenticated' },
        });
        const reader = live.actor('member-watcher', 'session-watcher', ['chats.read']);
        expect(live.core.attachLiveChannel(reader, 'live-1', sink)).toMatchObject({ problem: { code: 'forbidden' } });
        const controlOnly = live.actor('member-watcher', 'session-watcher', ['browser.control']);
        expect(live.core.attachLiveChannel(controlOnly, 'live-1', sink)).toMatchObject({
            problem: { code: 'forbidden', requiredPermission: 'browser.watch' },
        });
    });

    it('audits an attach whose handshake failed as failed, and lets the session attach again', async () => {
        const world = setup();
        const session = await watch(world);
        const result = world.core.attachLiveChannel(world.watcher, session.id, {
            send: () => undefined,
            close: () => undefined,
        });
        if (result.kind !== 'attached') throw new Error('refused');
        result.peer.closed();
        result.peer.opened();
        world.join(world.watcher, session.id);
        const entries = ok(await world.call(world.owner, R.listAuditEntries, { query: {} })) as unknown as {
            items: { action: string; outcome: string }[];
        };
        expect(
            entries.items
                .filter((entry) => entry.action === 'browser.channel.attach')
                .map(({ outcome }) => outcome)
                .sort(),
        ).toEqual(['failed', 'success']);
    });

    it('agrees a version, then sends the state, the origin and a PNG frame', async () => {
        const world = setup();
        const session = await watch(world);
        const viewer = world.join(world.watcher, session.id);
        expect(viewer.messages).toEqual([
            { type: 'hello', version: 1 },
            { type: 'state', mode: 'watching', agent: 'working', others: 0, viewport: FAKE_VIEWPORT },
            { type: 'navigated', origin: SITE },
        ]);
        expect(viewer.frames).toHaveLength(1);
        expect(viewer.frames[0]?.kind).toBe('tab-frame-png');
        expect([...(viewer.frames[0]?.payload.subarray(0, 4) ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    });

    it('sends frames only while it has credit and the view is visible', async () => {
        const world = setup();
        const session = await watch(world);
        const viewer = world.join(world.watcher, session.id);
        world.core.controller.browserTick();
        world.core.controller.browserTick();
        expect(viewer.frames).toHaveLength(2);
        viewer.send({ type: 'frame-ack', seq: 999 });
        expect(viewer.frames).toHaveLength(2);
        viewer.send({ type: 'frame-ack', seq: viewer.frames[0]?.seq });
        expect(viewer.frames).toHaveLength(3);
        viewer.send({ type: 'view', width: 640, height: 400, visible: false });
        viewer.send({ type: 'frame-ack', seq: viewer.frames[1]?.seq });
        world.core.controller.browserTick();
        expect(viewer.frames).toHaveLength(3);
        viewer.send({ type: 'view', width: 640, height: 400, visible: true });
        expect(viewer.frames).toHaveLength(4);
    });

    it.each([
        [
            'anything before hello',
            (viewer: Viewer) => {
                viewer.send({ type: 'frame-ack', seq: 1 });
            },
            false,
        ],
        [
            'a second hello',
            (viewer: Viewer) => {
                viewer.send({ type: 'hello', versions: [1] });
            },
            true,
        ],
        [
            'no shared version',
            (viewer: Viewer) => {
                viewer.send({ type: 'hello', versions: [9] });
            },
            false,
        ],
        [
            'an unknown message',
            (viewer: Viewer) => {
                viewer.send({ type: 'eval', code: 'alert(1)' });
            },
            true,
        ],
        [
            'binary media',
            (viewer: Viewer) => {
                viewer.peer.receive(new Uint8Array(20));
            },
            true,
        ],
        [
            'text that is not JSON',
            (viewer: Viewer) => {
                viewer.peer.receive('nope');
            },
            true,
        ],
    ])('ends with protocol-error on %s', async (_name, act, hello) => {
        const world = setup();
        const session = await watch(world);
        const viewer = hello ? world.join(world.watcher, session.id) : world.attach(world.watcher, session.id);
        act(viewer);
        expect(viewer.messages.at(-1)).toEqual({ type: 'end', reason: 'protocol-error' });
        expect(viewer.closed).toBe(1008);
        expect(
            ok(await world.call(world.watcher, R.getBrowserSession, { params: { sessionId: session.id } })),
        ).toMatchObject({
            status: 'ended',
            endReason: 'protocol-error',
        });
    });

    it('refuses a watcher’s input without closing, and ends a flood', async () => {
        const world = setup();
        const session = await watch(world);
        const viewer = world.join(world.watcher, session.id);
        viewer.input(click);
        expect(viewer.messages.at(-1)).toEqual({ type: 'input-refused', reason: 'not-controlling' });
        expect(viewer.closed).toBeNull();
        for (let index = 0; index < MAX_LIVE_INPUT_PER_S; index++) viewer.input({ ...click, action: 'move' });
        expect(viewer.messages.at(-1)).toEqual({ type: 'end', reason: 'protocol-error' });
    });

    it('lets the member end it', async () => {
        const world = setup();
        const session = await watch(world);
        const viewer = world.join(world.watcher, session.id);
        viewer.send({ type: 'end' });
        expect(viewer.messages.at(-1)).toEqual({ type: 'end', reason: 'ended' });
        expect(code(await world.call(world.watcher, R.takeBrowserControl, { params: { sessionId: session.id } }))).toBe(
            'forbidden',
        );
        expect(code(await world.call(world.owner, R.endBrowserSession, { params: { sessionId: session.id } }))).toBe(
            'not-found',
        );
        expect(
            world.core.attachLiveChannel(world.watcher, session.id, { send: () => undefined, close: () => undefined }),
        ).toMatchObject({ problem: { code: 'browser-session-ended' } });
    });
});

describe('control', () => {
    it('is exclusive, pauses the agent and replays the controller’s input', async () => {
        const world = setup();
        const tab = world.agentTab();
        const watching = await watch(world, world.watcher, tab.id);
        const watcherView = world.join(world.watcher, watching.id);
        const owned = await control(world, tab.id);
        expect(owned).toMatchObject({ mode: 'controlling', kind: 'agent-tab' });
        expect(world.core.controller.getBrowserTab(tab.id)).toMatchObject({ agentState: 'paused', participants: 2 });
        expect(watcherView.messages).toContainEqual(
            expect.objectContaining({ type: 'state', agent: 'paused', others: 1 }),
        );
        expect(code(await world.call(world.ownerLaptop, R.controlBrowserTab, { params: { tabId: tab.id } }))).toBe(
            'browser-tab-controlled',
        );
        const laptopWatch = await watch(world, world.ownerLaptop, tab.id);
        expect(
            code(await world.call(world.ownerLaptop, R.takeBrowserControl, { params: { sessionId: laptopWatch.id } })),
        ).toBe('browser-tab-controlled');
        expect(ok(await world.call(world.owner, R.takeBrowserControl, { params: { sessionId: owned.id } }))).toEqual(
            owned,
        );
        const ownerView = world.join(world.owner, owned.id);
        const frames = ownerView.frames.length;
        ownerView.send({ type: 'frame-ack', seq: ownerView.frames.at(-1)?.seq });
        ownerView.input(click);
        expect(ownerView.frames.length).toBeGreaterThan(frames);
        ownerView.input({
            kind: 'pointer',
            action: 'move',
            x: FAKE_VIEWPORT.width + 1,
            y: 1,
            button: 'none',
            clicks: 0,
        });
        expect(ownerView.messages.at(-1)).toEqual({ type: 'input-refused', reason: 'outside-viewport' });
        for (const key of ['h', 'Backspace', 'i']) {
            ownerView.input({ kind: 'key', action: 'down', key, shift: false });
            ownerView.input({ kind: 'key', action: 'up', key, shift: false });
        }
        ownerView.input({ kind: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 100 });
        expect(ownerView.closed).toBeNull();
    });

    it('takes control from a watching session, and hands it back idempotently', async () => {
        const world = setup();
        const tab = world.agentTab();
        const session = await watch(world, world.owner, tab.id);
        const params = { params: { sessionId: session.id } };
        expect(ok(await world.call(world.owner, R.handBackBrowserTab, params))).toMatchObject({ mode: 'watching' });
        const stale = world.actor('member-owner', 'session-current', OWNER_PERMISSIONS, false);
        expect(code(await world.call(stale, R.takeBrowserControl, params))).toBe('step-up-required');
        expect(ok(await world.call(world.owner, R.takeBrowserControl, params))).toMatchObject({ mode: 'controlling' });
        expect(ok(await world.call(world.owner, R.handBackBrowserTab, params))).toMatchObject({
            mode: 'watching',
            status: 'open',
        });
        expect(world.core.controller.getBrowserTab(tab.id)).toMatchObject({ agentState: 'working' });
        ok(await world.call(world.owner, R.endBrowserSession, params));
        expect(ok(await world.call(world.owner, R.endBrowserSession, params))).toMatchObject({ status: 'ended' });
        expect(code(await world.call(world.owner, R.takeBrowserControl, params))).toBe('browser-session-ended');
        expect(code(await world.call(world.owner, R.handBackBrowserTab, params))).toBe('browser-session-ended');
    });

    it('blocks frames on origins the agent’s task does not use, and on browser and secret pages', async () => {
        const world = setup();
        const tab = world.agentTab();
        const watching = await watch(world, world.watcher, tab.id);
        const viewer = world.join(world.watcher, watching.id);
        world.core.controller.navigateBrowserTab(tab.id, { kind: 'web', origin: OTHER });
        expect(viewer.messages.at(-1)).toEqual({ type: 'navigated', origin: OTHER });
        world.core.controller.navigateBrowserTab(tab.id, { kind: 'secret-page' });
        expect(viewer.messages.at(-1)).toEqual({ type: 'blocked', reason: 'secret-page', origin: null });
        world.core.controller.navigateBrowserTab(tab.id, { kind: 'browser-page' });
        expect(viewer.messages.at(-1)).toEqual({ type: 'blocked', reason: 'browser-page', origin: null });
        expect(world.core.controller.getBrowserTab(tab.id)).toMatchObject({ origin: null });
        world.core.controller.navigateBrowserTab(tab.id, { kind: 'web', origin: SITE });
        await control(world, tab.id);
        world.core.controller.navigateBrowserTab(tab.id, { kind: 'web', origin: OTHER });
        expect(viewer.messages.at(-1)).toEqual({ type: 'blocked', reason: 'origin-not-allowed', origin: OTHER });
    });
});

describe('help requests', () => {
    it('run from pending through control to handed-back, which the agent reads with the tab’s origin', async () => {
        const world = setup();
        const tab = world.agentTab();
        const request = world.core.controller.requestBrowserHelp(tab.id, {
            reason: 'captcha',
            message: 'A captcha blocks the checkout.'.padEnd(600, '.'),
        });
        expect(BrowserHelpRequest.parse(request)).toMatchObject({
            status: 'pending',
            chatId: 'chat-1',
            runId: 'run-1',
        });
        expect(request.message).toHaveLength(500);
        const elsewhere = setup();
        const folded = elsewhere.core.controller.requestBrowserHelp(elsewhere.agentTab().id, {
            reason: 'login',
            message: 'Sign in at\n\u202Eelpmaxe.moc\u202C please\u0007',
        });
        expect(folded.message).toBe('Sign in at elpmaxe.moc please');
        expect(world.core.controller.requestBrowserHelp(tab.id, { reason: 'other', message: 'again' })).toEqual(
            request,
        );
        expect(world.core.controller.getBrowserTab(tab.id)).toMatchObject({
            agentState: 'waiting',
            helpRequestId: request.id,
        });
        expect(world.events).toContainEqual({ type: 'browser-help.changed', requestId: request.id });
        expect(ok(await world.call(world.watcher, R.listBrowserHelpRequests, { query: {} }))).toEqual({
            items: [request],
        });
        const owned = await control(world, tab.id);
        expect(owned.helpRequestId).toBe(request.id);
        const params = { params: { requestId: request.id } };
        expect(ok(await world.call(world.watcher, R.getBrowserHelpRequest, params))).toMatchObject({
            status: 'in-progress',
        });
        expect(code(await world.call(world.owner, R.dismissBrowserHelpRequest, params))).toBe('browser-tab-controlled');
        world.advance(5_000);
        ok(await world.call(world.owner, R.handBackBrowserTab, { params: { sessionId: owned.id } }));
        const resolved = BrowserHelpRequest.parse(ok(await world.call(world.watcher, R.getBrowserHelpRequest, params)));
        expect(resolved).toMatchObject({
            status: 'resolved',
            resolution: {
                outcome: 'handed-back',
                origin: SITE,
                by: 'member-owner',
                at: new Date(START + 5_000).toISOString(),
            },
        });
        expect(world.core.controller.getBrowserTab(tab.id)).toMatchObject({
            agentState: 'working',
            helpRequestId: null,
        });
        expect(
            ok(await world.call(world.watcher, R.listBrowserHelpRequests, { query: { status: 'resolved' } })),
        ).toEqual({
            items: [resolved],
        });
        expect(code(await world.call(world.owner, R.dismissBrowserHelpRequest, params))).toBe('browser-help-resolved');
    });

    it('can be dismissed, which resumes the agent', async () => {
        const world = setup();
        const tab = world.agentTab();
        const request = world.core.controller.requestBrowserHelp(tab.id, { reason: 'login', message: 'Sign in?' });
        const params = { params: { requestId: request.id } };
        expect(code(await world.call(world.watcher, R.dismissBrowserHelpRequest, params))).toBe('forbidden');
        const blind = world.actor('member-watcher', 'session-watcher', ['browser.watch']);
        expect(code(await world.call(blind, R.getBrowserHelpRequest, params))).toBe('not-found');
        expect(ok(await world.call(world.owner, R.dismissBrowserHelpRequest, params))).toMatchObject({
            status: 'resolved',
            resolution: { outcome: 'dismissed', by: 'member-owner' },
        });
        expect(world.core.controller.getBrowserTab(tab.id)).toMatchObject({ agentState: 'working' });
        expect(
            code(await world.call(world.owner, R.dismissBrowserHelpRequest, { params: { requestId: 'help-9' } })),
        ).toBe('not-found');
    });

    it('joins a controller already on the tab, and ends blocked-origin when control ends off the allowlist', async () => {
        const world = setup();
        const tab = world.agentTab();
        const owned = await control(world, tab.id);
        const request = world.core.controller.requestBrowserHelp(tab.id, { reason: 'blocked', message: 'Stuck' });
        expect(request.status).toBe('in-progress');
        world.core.controller.navigateBrowserTab(tab.id, { kind: 'web', origin: OTHER });
        ok(await world.call(world.owner, R.endBrowserSession, { params: { sessionId: owned.id } }));
        expect(
            ok(await world.call(world.owner, R.getBrowserHelpRequest, { params: { requestId: request.id } })),
        ).toMatchObject({
            resolution: { outcome: 'blocked-origin', origin: OTHER },
        });
    });

    it('are cancelled when the agent’s work closes the tab, which ends every session on it', async () => {
        const world = setup();
        const tab = world.agentTab();
        const request = world.core.controller.requestBrowserHelp(tab.id, { reason: 'confirmation', message: 'OK?' });
        const session = await watch(world, world.watcher, tab.id);
        const viewer = world.join(world.watcher, session.id);
        world.core.controller.closeAgentTab(tab.id);
        expect(viewer.messages.at(-1)).toEqual({ type: 'end', reason: 'tab-closed' });
        expect(world.core.controller.getBrowserTab(tab.id)).toBeUndefined();
        expect(
            ok(await world.call(world.owner, R.getBrowserHelpRequest, { params: { requestId: request.id } })),
        ).toMatchObject({
            resolution: { outcome: 'cancelled', by: null },
        });
        expect(() => {
            world.core.controller.navigateBrowserTab(tab.id, { kind: 'browser-page' });
        }).toThrow();
    });

    it('come only from an agent’s tab', async () => {
        const world = setup();
        world.core.controller.setBrowserSignInOrigins([SITE]);
        const session = BrowserSession.parse(
            ok(await world.call(world.owner, R.openBrowserSignIn, { body: { browser: null, origin: SITE } })),
        );
        expect(() =>
            world.core.controller.requestBrowserHelp(session.tabId, { reason: 'other', message: '' }),
        ).toThrow();
    });
});

describe('time and revocation', () => {
    it('ends a session that never attached', async () => {
        const world = setup();
        const session = await watch(world);
        world.advance(LIVE_SESSION_ATTACH_MS + 1);
        world.core.controller.browserTick();
        expect(
            ok(await world.call(world.watcher, R.getBrowserSession, { params: { sessionId: session.id } })),
        ).toMatchObject({
            endReason: 'not-attached',
        });
    });

    it('ends a session whose channel dropped and did not attach again, handing a controlled tab back', async () => {
        const world = setup();
        const tab = world.agentTab();
        const watching = await watch(world, world.watcher, tab.id);
        world.join(world.watcher, watching.id).peer.closed();
        world.advance(LIVE_SESSION_ATTACH_MS - 1_000);
        world.core.controller.browserTick();
        const reloaded = world.join(world.watcher, watching.id);
        expect(reloaded.types()).toEqual(['hello', 'state', 'navigated']);
        const controlling = await control(world, tab.id);
        world.join(world.owner, controlling.id).peer.closed();
        world.advance(LIVE_SESSION_ATTACH_MS + 1);
        world.core.controller.browserTick();
        expect(
            ok(await world.call(world.owner, R.getBrowserSession, { params: { sessionId: controlling.id } })),
        ).toMatchObject({ status: 'ended', endReason: 'not-attached' });
        expect(world.core.controller.getBrowserTab(tab.id)).toMatchObject({ agentState: 'working', participants: 1 });
    });

    it('ends at endsAt, and a controller after the idle limit with the outcome idle', async () => {
        const world = setup();
        const tab = world.agentTab();
        const watching = await watch(world, world.watcher, tab.id);
        const watcherView = world.join(world.watcher, watching.id);
        const request = world.core.controller.requestBrowserHelp(tab.id, { reason: 'login', message: '' });
        const owned = await control(world, tab.id);
        const ownerView = world.join(world.owner, owned.id);
        world.advance(BROWSER_IDLE_MS - 1_000);
        ownerView.input(click);
        world.advance(BROWSER_IDLE_MS - 1_000);
        world.core.controller.browserTick();
        expect(ownerView.closed).toBeNull();
        world.advance(1_000);
        world.core.controller.browserTick();
        expect(ownerView.messages.at(-1)).toEqual({ type: 'end', reason: 'idle' });
        expect(
            ok(await world.call(world.owner, R.getBrowserHelpRequest, { params: { requestId: request.id } })),
        ).toMatchObject({
            resolution: { outcome: 'idle', by: null },
        });
        expect(watcherView.closed).toBeNull();
        world.advance(MAX_BROWSER_TAB_SESSION_MS);
        world.core.controller.browserTick();
        expect(watcherView.messages.at(-1)).toEqual({ type: 'end', reason: 'expired' });
    });

    it('elapses on the test-mode lever', async () => {
        const world = setup();
        const tab = world.agentTab();
        const owned = await control(world, tab.id);
        expect(world.core.controller.elapseBrowserSession(owned.id, 'idle')).toBe(true);
        expect(
            ok(await world.call(world.owner, R.getBrowserSession, { params: { sessionId: owned.id } })),
        ).toMatchObject({
            endReason: 'idle',
        });
        expect(world.core.controller.elapseBrowserSession(owned.id, 'expired')).toBe(false);
        const watching = await watch(world, world.watcher, tab.id);
        world.core.controller.elapseBrowserSession(watching.id, 'expired');
        expect(
            ok(await world.call(world.watcher, R.getBrowserSession, { params: { sessionId: watching.id } })),
        ).toMatchObject({
            endReason: 'expired',
        });
    });

    it('ends when the gateway session or the member is revoked', async () => {
        const world = setup();
        const tab = world.agentTab();
        const request = world.core.controller.requestBrowserHelp(tab.id, { reason: 'login', message: '' });
        const owned = await control(world, world.agentTab().id, world.ownerLaptop);
        const ownerView = world.join(world.ownerLaptop, owned.id);
        const watching = await watch(world, world.watcher, tab.id);
        const watcherView = world.join(world.watcher, watching.id);
        const ownerOnRequest = await control(world, tab.id);
        world.core.controller.removeSession('session-laptop');
        ownerView.send({ type: 'frame-ack', seq: 1 });
        expect(ownerView.messages.at(-1)).toEqual({ type: 'end', reason: 'revoked' });
        ok(await world.call(world.owner, R.removeMember, { params: { memberId: 'member-watcher' } }));
        world.core.controller.browserTick();
        expect(watcherView.messages.at(-1)).toEqual({ type: 'end', reason: 'revoked' });
        world.core.controller.removeSession('session-current');
        world.core.controller.browserTick();
        expect(world.core.controller.getBrowserTab(tab.id)).toMatchObject({ agentState: 'working', participants: 0 });
        expect(ownerOnRequest.helpRequestId).toBe(request.id);
    });

    it('ends at once when a request revokes the gateway session', async () => {
        const world = setup();
        const watching = await watch(world);
        const view = world.join(world.watcher, watching.id);
        ok(await world.call(world.owner, R.revokeSession, { params: { sessionId: 'session-watcher' } }));
        expect(view.messages.at(-1)).toEqual({ type: 'end', reason: 'revoked' });
        expect(view.closed).toBe(1000);
    });

    it('ends a member’s sessions once a request shows they lost browser.watch or sight of the work', async () => {
        const world = setup();
        const tab = world.agentTab();
        const watching = await watch(world, world.watcher, tab.id);
        const view = world.join(world.watcher, watching.id);
        const other = await watch(world, world.actor('member-watcher', 'session-other', WATCH), tab.id);
        await world.call(world.actor('member-watcher', 'session-watcher', ['chats.read']), R.getMe);
        expect(view.messages.at(-1)).toEqual({ type: 'end', reason: 'revoked' });
        // Another gateway session of the same member keeps what it holds.
        const params = { params: { sessionId: other.id } };
        const otherActor = world.actor('member-watcher', 'session-other', WATCH);
        expect(ok(await world.call(otherActor, R.getBrowserSession, params))).toMatchObject({ status: 'open' });
        const blind = world.actor('member-watcher', 'session-other', ['browser.watch', 'chats.read', 'agents.read']);
        expect(code(await world.call(blind, R.getBrowserSession, params))).toBe('ok');
        expect(ok(await world.call(otherActor, R.getBrowserSession, params))).toMatchObject({
            status: 'ended',
            endReason: 'revoked',
        });
    });

    it('ends control when the controller loses browser.control, resuming the agent with revoked', async () => {
        const world = setup();
        const tab = world.agentTab();
        const request = world.core.controller.requestBrowserHelp(tab.id, { reason: 'login', message: 'Sign in.' });
        const owned = await control(world, tab.id);
        const view = world.join(world.owner, owned.id);
        const demoted = world.actor('member-owner', 'session-current', [...WATCH]);
        expect(code(await world.call(demoted, R.handBackBrowserTab, { params: { sessionId: owned.id } }))).toBe(
            'forbidden',
        );
        expect(view.messages.at(-1)).toEqual({ type: 'end', reason: 'revoked' });
        expect(world.core.controller.getBrowserTab(tab.id)).toMatchObject({ agentState: 'working', participants: 0 });
        const resolved = ok(await world.call(demoted, R.getBrowserHelpRequest, { params: { requestId: request.id } }));
        expect(resolved).toMatchObject({ resolution: { outcome: 'revoked', by: null } });
    });

    it('asks browserPermissions on every sweep, so a role change applies without a request', async () => {
        let held: ReadonlySet<Permission> | null = null;
        const world = setup({ browserPermissions: (memberId) => (memberId === 'member-watcher' ? held : null) });
        world.core.controller.setBrowserSignInOrigins([SITE]);
        const signIn = BrowserSession.parse(
            ok(await world.call(world.owner, R.openBrowserSignIn, { body: { browser: null, origin: SITE } })),
        );
        const watching = await watch(world);
        const view = world.join(world.watcher, watching.id);
        world.core.controller.browserTick();
        expect(view.messages.at(-1)?.type).not.toBe('end');
        held = new Set(['browser.watch', 'agents.read']);
        world.core.controller.browserTick();
        expect(view.messages.at(-1)).toEqual({ type: 'end', reason: 'revoked' });
        const params = { params: { sessionId: signIn.id } };
        expect(ok(await world.call(world.owner, R.getBrowserSession, params))).toMatchObject({ status: 'open' });
    });

    it('ends a sign-in session whose owner loses browser.control', async () => {
        const world = setup();
        world.core.controller.setBrowserSignInOrigins([SITE]);
        const signIn = BrowserSession.parse(
            ok(await world.call(world.owner, R.openBrowserSignIn, { body: { browser: null, origin: SITE } })),
        );
        const demoted = world.actor('member-owner', 'session-current', ['browser.watch']);
        expect(ok(await world.call(demoted, R.getBrowserSession, { params: { sessionId: signIn.id } }))).toMatchObject({
            status: 'ended',
            endReason: 'revoked',
        });
    });
});

describe('the audit log', () => {
    it('records metadata only: never typed text, frames or a URL', async () => {
        const world = setup();
        world.core.controller.setBrowserSignInOrigins([SITE]);
        const session = BrowserSession.parse(
            ok(await world.call(world.owner, R.openBrowserSignIn, { body: { browser: null, origin: SITE } })),
        );
        world.core.attachLiveChannel(world.ownerLaptop, session.id, { send: () => undefined, close: () => undefined });
        const viewer = world.join(world.owner, session.id);
        for (const key of 'hunter2') viewer.input({ kind: 'key', action: 'down', key, shift: false });
        world.core.controller.elapseBrowserSession(session.id, 'expired');
        const entries = ok(await world.call(world.owner, R.listAuditEntries, { query: {} })) as unknown as {
            items: { action: string; outcome: string; target: { name: string | null } | null; details: unknown }[];
        };
        const browser = entries.items.filter((entry) => entry.action.startsWith('browser.'));
        expect(browser.map(({ action, outcome }) => `${action} ${outcome}`).sort()).toEqual([
            'browser.channel.attach denied',
            'browser.channel.attach success',
            'browser.session.end success',
            'browser.sign-in.open success',
        ]);
        expect(browser.find((entry) => entry.action === 'browser.sign-in.open')?.target?.name).toBe(SITE);
        expect(browser.find((entry) => entry.action === 'browser.session.end')?.details).toEqual({
            reason: 'expired',
            seconds: 0,
        });
        const text = JSON.stringify(entries);
        expect(text).not.toMatch(/hunter|"key"|tab-frame|\/login/);
    });

    it('records an end sent over the channel as the member’s', async () => {
        const world = setup();
        const session = await watch(world);
        world.advance(3_000);
        world.join(world.watcher, session.id).send({ type: 'end' });
        const entries = ok(await world.call(world.owner, R.listAuditEntries, { query: {} })) as unknown as {
            items: { action: string; actor: unknown; details: unknown }[];
        };
        expect(entries.items.find((entry) => entry.action === 'browser.session.end')).toMatchObject({
            actor: { kind: 'member', memberId: 'member-watcher' },
            details: { reason: 'ended', seconds: 3 },
        });
    });
});
