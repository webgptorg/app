import { KNOWN_CAPABILITIES, supports } from '../capabilities/capability';
import type { AuditAction, AuditActor, AuditDetails, AuditTarget } from '../audit';
import {
    BROWSER_IDLE_MS,
    BrowserHelpRequestId,
    BrowserTabId,
    LIVE_SESSION_ATTACH_MS,
    MAX_BROWSER_HELP_REQUESTS,
    MAX_BROWSER_PARTICIPANTS,
    MAX_BROWSER_TAB_SESSION_MS,
    MAX_BROWSER_TABS,
    toBrowserHelpMessage,
} from '../capabilities/live';
import type {
    BrowserHelpOutcome,
    BrowserHelpReason,
    BrowserHelpRequest,
    BrowserSession,
    BrowserTab,
} from '../capabilities/live';
import {
    MAX_LIVE_INPUT_PER_S,
    MAX_UNACKED_FRAMES,
    agreeLiveChannelVersion,
    encodeLiveMedia,
    parseLiveClientMessage,
} from '../capabilities/live-channel';
import type {
    BrowserAgentState,
    BrowserSessionMode,
    LiveEndReason,
    LiveEngineMessage,
    LiveInputEvent,
} from '../capabilities/live-channel';
import { AgentId, ChatId, LiveSessionId, RunId, TaskId, Timestamp } from '../common';
import type { ClientInfo, MemberId, ProblemDetails, SessionId } from '../common';
import type { Permission } from '../permissions';
import { createProblem } from '../problem';
import { FAKE_FRAME_WIDTH, renderFakeFrame } from './fake-frame';
import { fail, invalid, notFound, ok, time } from './kit';
import type { Actor, EngineContext, HandlerContext, HandlerResult, Handlers } from './kit';

/**
 * The in-memory engine's live browser (`browser-tab@1`): a fake browser whose tabs are records, a screencast of small
 * PNGs, and the channel protocol over a {@link LiveChannelSink} that a server binds to a real WebSocket. Time-based ends
 * (attach deadline, `endsAt`, idle) happen on a sweep: every request and channel message runs one, and an engine built
 * on the core calls `controller.browserTick()` on a timer.
 */

/** The fake tab's viewport in CSS pixels; frames are drawn at a fifth of it. */
export const FAKE_VIEWPORT = { width: 1280, height: 800 } as const;
const FRAME_SCALE = FAKE_VIEWPORT.width / FAKE_FRAME_WIDTH;
const DEFAULT_BROWSER = 'default';

/** What the fake tab shows: a web page at an origin, or a page whose frames must never leave the engine. */
export type FakePage =
    | { readonly kind: 'web'; readonly origin: string }
    | { readonly kind: 'browser-page' }
    | { readonly kind: 'secret-page' };

/** Where the server sends the channel's messages; it closes the WebSocket on `close`. */
export interface LiveChannelSink {
    send(data: string | Uint8Array): void;
    close(code: number): void;
}

/**
 * What the server feeds from the WebSocket: `opened` once the handshake completed, every message, then `closed` once
 * when it drops. A `closed` without `opened` is a handshake that failed after the engine accepted it.
 */
export interface LiveChannelPeer {
    opened(): void;
    receive(data: string | Uint8Array): void;
    closed(): void;
}

export type LiveChannelAttach =
    | { readonly kind: 'attached'; readonly peer: LiveChannelPeer }
    | { readonly kind: 'refused'; readonly problem: ProblemDetails };

interface ChannelRecord {
    readonly sink: LiveChannelSink;
    version: number | null;
    visible: boolean;
    readonly unacked: Set<number>;
    inputWindowStart: number;
    inputCount: number;
}

interface TabRecord {
    readonly id: BrowserTabId;
    readonly kind: 'sign-in' | 'agent-tab';
    readonly walletOrigin?: string;
    readonly browser: string;
    readonly agentId: AgentId | null;
    readonly chatId: ChatId | null;
    readonly taskId: TaskId | null;
    readonly runId: RunId | null;
    page: FakePage;
    agentState: BrowserAgentState;
    controller: LiveSessionId | null;
    /** Origins a controller may take the tab to, set when control starts. Watching an agent shows any web origin. */
    allowed: ReadonlySet<string>;
    helpRequestId: BrowserHelpRequestId | null;
    readonly openedAt: Timestamp;
    tick: number;
    pointer: { x: number; y: number } | null;
    typed: number;
}

interface SessionRecord {
    readonly id: LiveSessionId;
    readonly kind: TabRecord['kind'];
    readonly tabId: BrowserTabId;
    readonly memberId: MemberId;
    readonly gatewaySessionId: SessionId;
    /** Whether the gateway session was listed when this opened, so its revocation can be noticed. */
    readonly gatewaySessionListed: boolean;
    /** What the gateway session held at its latest request, for engines that cannot ask for it now. */
    permissions: ReadonlySet<Permission>;
    mode: BrowserSessionMode;
    status: 'open' | 'ended';
    endReason: LiveEndReason | null;
    helpRequestId: BrowserHelpRequestId | null;
    readonly openedAt: Timestamp;
    attachBy: Timestamp;
    endsAt: Timestamp;
    lastInputAt: number;
    attached: boolean;
    channel: ChannelRecord | null;
}

export interface LiveAuditInput {
    readonly actor: AuditActor;
    readonly action: AuditAction;
    readonly target: AuditTarget | null;
    readonly outcome: 'success' | 'denied' | 'failed';
    readonly client: ClientInfo | null;
    readonly details: AuditDetails | null;
}

/** Mutable on purpose, like the rest of the in-memory state. */
export interface InMemoryBrowser {
    readonly tabs: Map<string, TabRecord>;
    readonly sessions: Map<string, SessionRecord>;
    readonly helpRequests: Map<string, BrowserHelpRequest>;
    /** Origins the owner allowed for remote sign-in, besides the Wallet's. */
    signInOrigins: ReadonlySet<string>;
    /** Where engine-initiated events (attach, timeouts, revocation) are audited; the core sets it. */
    audit: (input: LiveAuditInput) => void;
    /** What a gateway session holds now, or `null` to go by its latest request; the core sets it. */
    permissionsOf: (memberId: MemberId, sessionId: SessionId) => ReadonlySet<Permission> | null;
}

export function createInMemoryBrowser(): InMemoryBrowser {
    return {
        tabs: new Map(),
        sessions: new Map(),
        helpRequests: new Map(),
        signInOrigins: new Set(),
        audit: () => undefined,
        permissionsOf: () => null,
    };
}

const at = (ms: number): Timestamp => Timestamp.parse(new Date(ms).toISOString());

/** The origin a session may show now, or `null` while frames must stop. */
function visibleOrigin(tab: TabRecord): string | null {
    if (tab.page.kind !== 'web') return null;
    if (tab.kind === 'agent-tab' && tab.controller === null) return tab.page.origin;
    return tab.allowed.has(tab.page.origin) ? tab.page.origin : null;
}

function blockedMessage(tab: TabRecord): LiveEngineMessage {
    switch (tab.page.kind) {
        case 'web':
            return { type: 'blocked', reason: 'origin-not-allowed', origin: tab.page.origin };
        case 'browser-page':
            return { type: 'blocked', reason: 'browser-page', origin: null };
        case 'secret-page':
            return { type: 'blocked', reason: 'secret-page', origin: null };
    }
}

function pageMessage(tab: TabRecord): LiveEngineMessage {
    const origin = visibleOrigin(tab);
    return origin === null ? blockedMessage(tab) : { type: 'navigated', origin };
}

function openSessionsOn(browser: InMemoryBrowser, tabId: string): SessionRecord[] {
    return [...browser.sessions.values()].filter((session) => session.tabId === tabId && session.status === 'open');
}

function sessionView(browser: InMemoryBrowser, session: SessionRecord): BrowserSession {
    const tab = browser.tabs.get(session.tabId);
    return {
        id: session.id,
        kind: session.kind,
        tabId: session.tabId,
        browser: tab?.browser ?? DEFAULT_BROWSER,
        mode: session.mode,
        origin: session.status === 'open' && tab ? visibleOrigin(tab) : null,
        status: session.status,
        endReason: session.endReason,
        helpRequestId: session.helpRequestId,
        openedAt: session.openedAt,
        attachBy: session.attachBy,
        endsAt: session.endsAt,
    };
}

function tabView(browser: InMemoryBrowser, tab: TabRecord): BrowserTab {
    return {
        id: tab.id,
        browser: tab.browser,
        agentId: tab.agentId,
        chatId: tab.chatId,
        taskId: tab.taskId,
        runId: tab.runId,
        origin: tab.page.kind === 'web' ? tab.page.origin : null,
        agentState: tab.agentState,
        participants: openSessionsOn(browser, tab.id).length,
        helpRequestId: tab.helpRequestId,
        openedAt: tab.openedAt,
    };
}

/** The in-memory engine has no per-chat access rules: a member sees the work through the area's read permission. */
function canSee(permissions: ReadonlySet<Permission>, links: Pick<TabRecord, 'chatId' | 'taskId' | 'runId'>): boolean {
    return (
        permissions.has('browser.watch') &&
        (links.chatId === null || permissions.has('chats.read')) &&
        (links.taskId === null || permissions.has('tasks.read')) &&
        (links.runId === null || permissions.has('runs.read'))
    );
}

function send(session: SessionRecord, message: LiveEngineMessage): void {
    session.channel?.sink.send(JSON.stringify(message));
}

function sendState(browser: InMemoryBrowser, session: SessionRecord, tab: TabRecord): void {
    send(session, {
        type: 'state',
        mode: session.mode,
        agent: tab.agentState,
        others: openSessionsOn(browser, tab.id).length - 1,
        viewport: { ...FAKE_VIEWPORT },
    });
}

function sendFrame(ctx: EngineContext, session: SessionRecord, tab: TabRecord): void {
    const channel = session.channel;
    if (channel?.version == null || !channel.visible || channel.unacked.size >= MAX_UNACKED_FRAMES) return;
    const origin = visibleOrigin(tab);
    if (origin === null) return;
    tab.tick++;
    const pointer = tab.pointer && { x: tab.pointer.x / FRAME_SCALE, y: tab.pointer.y / FRAME_SCALE };
    const encoded = encodeLiveMedia({
        kind: 'tab-frame-png',
        seq: tab.tick,
        timestamp: time(ctx.now()),
        payload: renderFakeFrame({ origin, tick: tab.tick, pointer, typed: tab.typed }),
    });
    /* v8 ignore next -- the fake frame is far below the cap; a real engine lowers quality instead */
    if (encoded.kind !== 'ok') return;
    channel.unacked.add(tab.tick);
    channel.sink.send(encoded.bytes);
}

interface Broadcast {
    readonly state?: boolean;
    readonly page?: boolean;
    readonly frame?: boolean;
}

function broadcast(ctx: EngineContext, tab: TabRecord, what: Broadcast): void {
    for (const session of openSessionsOn(ctx.state.browser, tab.id)) {
        if (session.channel?.version == null) continue;
        if (what.state === true) sendState(ctx.state.browser, session, tab);
        if (what.page === true) send(session, pageMessage(tab));
        if (what.frame === true) sendFrame(ctx, session, tab);
    }
}

function tabChanged(ctx: EngineContext, tab: TabRecord): void {
    if (tab.kind === 'agent-tab') ctx.publish({ type: 'browser-tab.changed', tabId: tab.id });
}

function updateHelp(ctx: EngineContext, request: BrowserHelpRequest, change: Partial<BrowserHelpRequest>): void {
    ctx.state.browser.helpRequests.set(request.id, { ...request, ...change, updatedAt: ctx.now() });
    ctx.publish({ type: 'browser-help.changed', requestId: request.id });
}

/** What the waiting agent is told: the outcome and where the tab is, never frames or what was typed. */
function resolveHelp(ctx: EngineContext, tab: TabRecord, outcome: BrowserHelpOutcome, by: MemberId | null): void {
    const request = tab.helpRequestId === null ? undefined : ctx.state.browser.helpRequests.get(tab.helpRequestId);
    tab.helpRequestId = null;
    if (request === undefined || request.status === 'resolved') return;
    updateHelp(ctx, request, {
        status: 'resolved',
        resolution: { outcome, origin: tab.page.kind === 'web' ? tab.page.origin : null, by, at: ctx.now() },
    });
}

const HELP_OUTCOME_BY_END: Readonly<Record<LiveEndReason, BrowserHelpOutcome>> = {
    ended: 'ended',
    expired: 'expired',
    idle: 'idle',
    'not-attached': 'ended',
    revoked: 'revoked',
    'tab-closed': 'cancelled',
    'engine-stopped': 'cancelled',
    'protocol-error': 'ended',
};

/** Control returns to the agent, which resumes; it learns how through its help request's outcome. */
function releaseControl(ctx: EngineContext, tab: TabRecord, outcome: BrowserHelpOutcome, by: MemberId | null): void {
    const blocked = visibleOrigin(tab) === null && outcome !== 'cancelled';
    tab.controller = null;
    tab.allowed = new Set();
    tab.agentState = 'working';
    resolveHelp(ctx, tab, blocked ? 'blocked-origin' : outcome, by);
}

function endSession(ctx: EngineContext, session: SessionRecord, reason: LiveEndReason, by: MemberId | null): void {
    if (session.status === 'ended') return;
    const { browser } = ctx.state;
    session.status = 'ended';
    session.endReason = reason;
    if (session.channel) {
        send(session, { type: 'end', reason });
        session.channel.sink.close(reason === 'protocol-error' ? 1008 : 1000);
        session.channel = null;
    }
    // A member's own end is audited by its route; the engine's ends are audited here, with no content.
    if (by === null) {
        browser.audit({
            actor: { kind: 'system' },
            action: 'browser.session.end',
            target: { kind: 'browser-session', id: session.id, name: null },
            outcome: 'success',
            client: null,
            details: { reason, seconds: Math.round((time(ctx.now()) - time(session.openedAt)) / 1000) },
        });
    }
    const tab = browser.tabs.get(session.tabId);
    if (!tab) return;
    if (tab.kind === 'sign-in') {
        // The sign-in tab lives exactly as long as its session; the login it produced stays in the profile.
        browser.tabs.delete(tab.id);
        return;
    }
    if (tab.controller === session.id) releaseControl(ctx, tab, HELP_OUTCOME_BY_END[reason], by);
    broadcast(ctx, tab, { state: true, page: true, frame: true });
    tabChanged(ctx, tab);
}

/**
 * Whether the member still holds what the session needs: the tab's work in sight (`browser.watch`, a sign-in tab
 * included) and, while controlling, `browser.control`.
 */
function stillPermitted(browser: InMemoryBrowser, session: SessionRecord): boolean {
    const held = browser.permissionsOf(session.memberId, session.gatewaySessionId) ?? session.permissions;
    const tab = browser.tabs.get(session.tabId);
    /* v8 ignore next -- a tab's sessions end before it is forgotten */
    if (!tab) return true;
    return canSee(held, tab) && (session.mode === 'watching' || held.has('browser.control'));
}

/** Ends what ran out of time, or lost its member, its gateway session or the permission it needs. */
export function sweepBrowser(ctx: EngineContext): void {
    const now = time(ctx.now());
    for (const session of [...ctx.state.browser.sessions.values()]) {
        if (session.status === 'ended') continue;
        if (
            !ctx.state.members.has(session.memberId) ||
            (session.gatewaySessionListed && !ctx.state.sessions.has(session.gatewaySessionId)) ||
            !stillPermitted(ctx.state.browser, session)
        ) {
            endSession(ctx, session, 'revoked', null);
        } else if (!session.attached && now > time(session.attachBy)) {
            endSession(ctx, session, 'not-attached', null);
        } else if (now >= time(session.endsAt)) {
            endSession(ctx, session, 'expired', null);
        } else if (session.mode === 'controlling' && now - session.lastInputAt >= BROWSER_IDLE_MS) {
            endSession(ctx, session, 'idle', null);
        }
    }
}

/**
 * A request or an attach by `actor`: its gateway session's sessions go by what it holds now, and end if that is no
 * longer enough. Engines whose `permissionsOf` answers learn of a change without waiting for a request.
 */
export function noteBrowserActor(ctx: EngineContext, actor: Actor): void {
    for (const session of ctx.state.browser.sessions.values()) {
        if (session.gatewaySessionId === actor.sessionId && session.memberId === actor.memberId) {
            session.permissions = actor.permissions;
        }
    }
    sweepBrowser(ctx);
}

/** Another gateway session's, the same member's included, is reported exactly like a missing one. */
function ownSession(ctx: HandlerContext, sessionId: string): SessionRecord | undefined {
    const session = ctx.state.browser.sessions.get(sessionId);
    return session?.gatewaySessionId === ctx.actor.sessionId && session.memberId === ctx.member.id
        ? session
        : undefined;
}

function viewOwn(ctx: HandlerContext, session: SessionRecord): HandlerResult<BrowserSession> {
    return ok(sessionView(ctx.state.browser, session));
}

/** The Wallet's login and request origins and those the owner added: where a remote sign-in may go. */
function signInAllowlist(ctx: EngineContext): Set<string> {
    const origins = new Set(ctx.state.browser.signInOrigins);
    for (const record of ctx.state.wallet.records.values()) origins.add(record.origin);
    for (const request of ctx.state.wallet.requests.values()) origins.add(request.origin);
    origins.delete(`https://${ctx.state.engine.hostname}`);
    return origins;
}

function takeControl(ctx: EngineContext, tab: TabRecord, session: SessionRecord): void {
    session.mode = 'controlling';
    session.lastInputAt = time(ctx.now());
    tab.controller = session.id;
    if (tab.kind === 'sign-in') return;
    tab.agentState = 'paused';
    // The controller may stay where the agent was and go where a sign-in may go; anywhere else stops the frames.
    tab.allowed = new Set([...(tab.page.kind === 'web' ? [tab.page.origin] : []), ...signInAllowlist(ctx)]);
    const request = tab.helpRequestId === null ? undefined : ctx.state.browser.helpRequests.get(tab.helpRequestId);
    if (request?.status === 'pending') {
        session.helpRequestId = request.id;
        updateHelp(ctx, request, { status: 'in-progress' });
    }
}

function openSession(ctx: HandlerContext, tab: TabRecord, mode: BrowserSessionMode): HandlerResult<BrowserSession> {
    const now = time(ctx.now());
    const session: SessionRecord = {
        id: ctx.newId(LiveSessionId, 'live'),
        kind: tab.kind,
        tabId: tab.id,
        memberId: ctx.member.id,
        gatewaySessionId: ctx.actor.sessionId,
        gatewaySessionListed: ctx.state.sessions.has(ctx.actor.sessionId),
        permissions: ctx.permissions,
        mode: 'watching',
        status: 'open',
        endReason: null,
        helpRequestId: null,
        openedAt: at(now),
        attachBy: at(now + LIVE_SESSION_ATTACH_MS),
        endsAt: at(now + MAX_BROWSER_TAB_SESSION_MS),
        lastInputAt: now,
        attached: false,
        channel: null,
    };
    ctx.state.browser.sessions.set(session.id, session);
    if (mode === 'controlling') takeControl(ctx, tab, session);
    broadcast(ctx, tab, { state: true, page: mode === 'controlling' });
    tabChanged(ctx, tab);
    return viewOwn(ctx, session);
}

function agentTab(ctx: HandlerContext, tabId: string): TabRecord | undefined {
    const tab = ctx.state.browser.tabs.get(tabId);
    return tab?.kind === 'agent-tab' && canSee(ctx.permissions, tab) ? tab : undefined;
}

const controlled = (): HandlerResult<never> =>
    fail('browser-tab-controlled', { detail: 'Someone else controls this tab.' });
const full = (): HandlerResult<never> =>
    fail('browser-tab-full', { detail: 'Too many sessions are open on this tab.' });

type LiveRoute =
    | 'openLiveAudioSession'
    | 'openBrowserSignIn'
    | 'listBrowserTabs'
    | 'watchBrowserTab'
    | 'controlBrowserTab'
    | 'getBrowserSession'
    | 'takeBrowserControl'
    | 'handBackBrowserTab'
    | 'endBrowserSession'
    | 'listBrowserHelpRequests'
    | 'getBrowserHelpRequest'
    | 'dismissBrowserHelpRequest';

/** Every browser route first ends what ran out, so a request never sees a session past its time. */
function swept<Request, Result>(
    handler: (request: Request, ctx: HandlerContext) => Result,
): (request: Request, ctx: HandlerContext) => Result {
    return (request, ctx) => {
        sweepBrowser(ctx);
        return handler(request, ctx);
    };
}

export const LIVE_HANDLERS: Pick<Handlers, LiveRoute> = {
    // Live audio stays reserved: even a core told to advertise it has nothing to open.
    openLiveAudioSession: () => fail('capability-not-supported'),
    openBrowserSignIn: swept(({ body }, ctx) => {
        const { browser } = ctx.state;
        if (body.wallet && !supports(ctx.state.engine, KNOWN_CAPABILITIES.walletSignIn)) {
            return fail('capability-not-supported');
        }
        if (body.wallet !== undefined || !supports(ctx.state.engine, KNOWN_CAPABILITIES.browserTab)) {
            if (ctx.member.role !== 'owner' || !ctx.actor.permissions.has('wallet.manage')) return fail('forbidden');
            const target = body.wallet;
            if (!target) return fail('browser-origin-refused');
            const item =
                target.kind === 'request'
                    ? ctx.state.wallet.requests.get(target.id)
                    : ctx.state.wallet.records.get(target.id);
            if (!item) return notFound('wallet item');
            if (item.origin !== body.origin) return fail('browser-origin-refused');
            if (target.kind === 'request' && 'step' in item && item.step !== target.step)
                return fail('wallet-request-moved');
        }
        if (body.browser !== null && body.browser !== DEFAULT_BROWSER)
            return invalid('body.browser', 'No such browser.');
        if (!signInAllowlist(ctx).has(body.origin)) {
            return fail('browser-origin-refused', { detail: 'This origin is not on the engine’s sign-in allowlist.' });
        }
        if ([...browser.tabs.values()].some((tab) => tab.kind === 'sign-in')) {
            return fail('browser-busy', { detail: 'Another sign-in session is open on this engine.' });
        }
        const tab: TabRecord = {
            id: ctx.newId(BrowserTabId, 'tab'),
            kind: 'sign-in',
            ...(body.wallet ? { walletOrigin: body.origin } : {}),
            browser: DEFAULT_BROWSER,
            agentId: null,
            chatId: null,
            taskId: null,
            runId: null,
            page: { kind: 'web', origin: body.origin },
            agentState: 'none',
            controller: null,
            allowed: new Set([body.origin]),
            helpRequestId: null,
            openedAt: ctx.now(),
            tick: 0,
            pointer: null,
            typed: 0,
        };
        browser.tabs.set(tab.id, tab);
        return openSession(ctx, tab, 'controlling');
    }),
    listBrowserTabs: swept(({ query }, ctx) => {
        const tabs = [...ctx.state.browser.tabs.values()]
            .filter(
                (tab) =>
                    tab.kind === 'agent-tab' &&
                    canSee(ctx.permissions, tab) &&
                    (query.chatId === undefined || tab.chatId === query.chatId) &&
                    (query.taskId === undefined || tab.taskId === query.taskId) &&
                    (query.runId === undefined || tab.runId === query.runId),
            )
            .sort((a, b) => time(b.openedAt) - time(a.openedAt))
            .slice(0, MAX_BROWSER_TABS);
        return ok({ items: tabs.map((tab) => tabView(ctx.state.browser, tab)) });
    }),
    watchBrowserTab: swept(({ params }, ctx) => {
        const tab = agentTab(ctx, params.tabId);
        if (!tab) return notFound('browser tab');
        // Watchers fill one place fewer than the cap, so watching can never lock an owner out of taking control.
        const watchers = openSessionsOn(ctx.state.browser, tab.id).filter((session) => session.mode === 'watching');
        if (watchers.length >= MAX_BROWSER_PARTICIPANTS - 1) return full();
        return openSession(ctx, tab, 'watching');
    }),
    controlBrowserTab: swept(({ params }, ctx) => {
        const tab = agentTab(ctx, params.tabId);
        if (!tab) return notFound('browser tab');
        if (tab.controller !== null) return controlled();
        return openSession(ctx, tab, 'controlling');
    }),
    getBrowserSession: swept(({ params }, ctx) => {
        const session = ownSession(ctx, params.sessionId);
        return session ? viewOwn(ctx, session) : notFound('browser session');
    }),
    takeBrowserControl: swept(({ params }, ctx) => {
        const session = ownSession(ctx, params.sessionId);
        if (!session) return notFound('browser session');
        const tab = ctx.state.browser.tabs.get(session.tabId);
        if (session.status === 'ended' || !tab) return fail('browser-session-ended');
        if (tab.controller === session.id) return viewOwn(ctx, session);
        if (tab.controller !== null) return controlled();
        takeControl(ctx, tab, session);
        broadcast(ctx, tab, { state: true, page: true, frame: true });
        tabChanged(ctx, tab);
        return viewOwn(ctx, session);
    }),
    handBackBrowserTab: swept(({ params }, ctx) => {
        const session = ownSession(ctx, params.sessionId);
        if (!session) return notFound('browser session');
        const tab = ctx.state.browser.tabs.get(session.tabId);
        if (session.status === 'ended' || !tab) return fail('browser-session-ended');
        if (tab.controller !== session.id) return viewOwn(ctx, session);
        if (tab.kind === 'sign-in') {
            if (tab.walletOrigin && visibleOrigin(tab) !== tab.walletOrigin) return fail('wallet-sign-in-incomplete');
            endSession(ctx, session, 'ended', ctx.member.id);
            return viewOwn(ctx, session);
        }
        session.mode = 'watching';
        releaseControl(ctx, tab, 'handed-back', ctx.member.id);
        broadcast(ctx, tab, { state: true, page: true, frame: true });
        tabChanged(ctx, tab);
        return viewOwn(ctx, session);
    }),
    endBrowserSession: swept(({ params }, ctx) => {
        const session = ownSession(ctx, params.sessionId);
        if (!session) return notFound('browser session');
        endSession(ctx, session, 'ended', ctx.member.id);
        return viewOwn(ctx, session);
    }),
    listBrowserHelpRequests: swept(({ query }, ctx) => {
        const resolved = query.status === 'resolved';
        const items = [...ctx.state.browser.helpRequests.values()]
            .filter((request) => canSee(ctx.permissions, request) && (request.status === 'resolved') === resolved)
            .sort((a, b) => (resolved ? time(b.updatedAt) - time(a.updatedAt) : time(a.createdAt) - time(b.createdAt)))
            .slice(0, MAX_BROWSER_HELP_REQUESTS);
        return ok({ items });
    }),
    getBrowserHelpRequest: swept(({ params }, ctx) => {
        const request = ctx.state.browser.helpRequests.get(params.requestId);
        return request && canSee(ctx.permissions, request) ? ok(request) : notFound('help request');
    }),
    dismissBrowserHelpRequest: swept(({ params }, ctx) => {
        const request = ctx.state.browser.helpRequests.get(params.requestId);
        if (!request || !canSee(ctx.permissions, request)) return notFound('help request');
        if (request.status === 'resolved') return fail('browser-help-resolved');
        const tab = ctx.state.browser.tabs.get(request.tabId);
        if (tab?.controller != null) return controlled();
        if (tab) {
            tab.agentState = 'working';
            resolveHelp(ctx, tab, 'dismissed', ctx.member.id);
            broadcast(ctx, tab, { state: true });
            tabChanged(ctx, tab);
        }
        return ok(ctx.state.browser.helpRequests.get(request.id) ?? request);
    }),
};

/** Whether the picture changed, so viewers get a new frame. Typed characters are counted, never kept. */
function applyInput(tab: TabRecord, event: LiveInputEvent): boolean {
    switch (event.kind) {
        case 'pointer':
            tab.pointer = { x: event.x, y: event.y };
            return event.action !== 'move';
        case 'wheel':
            return true;
        case 'key':
            if (event.action === 'up') return false;
            if (event.key === 'Backspace') tab.typed = Math.max(0, tab.typed - 1);
            // Named keys are all longer than one code point, which is at most two UTF-16 units.
            else if (event.key.length <= 2) tab.typed++;
            return true;
    }
}

function receiveInput(ctx: EngineContext, session: SessionRecord, tab: TabRecord, event: LiveInputEvent): void {
    const channel = session.channel;
    /* v8 ignore next -- receive() only runs for an attached channel */
    if (!channel) return;
    const now = time(ctx.now());
    if (now - channel.inputWindowStart >= 1000) {
        channel.inputWindowStart = now;
        channel.inputCount = 0;
    }
    if (++channel.inputCount > MAX_LIVE_INPUT_PER_S) {
        endSession(ctx, session, 'protocol-error', null);
        return;
    }
    if (tab.controller !== session.id) {
        send(session, { type: 'input-refused', reason: 'not-controlling' });
        return;
    }
    if (visibleOrigin(tab) === null) {
        send(session, { type: 'input-refused', reason: 'blocked' });
        return;
    }
    if (event.kind !== 'key' && (event.x > FAKE_VIEWPORT.width || event.y > FAKE_VIEWPORT.height)) {
        send(session, { type: 'input-refused', reason: 'outside-viewport' });
        return;
    }
    session.lastInputAt = now;
    if (applyInput(tab, event)) broadcast(ctx, tab, { frame: true });
}

function receive(ctx: EngineContext, session: SessionRecord, data: string | Uint8Array): void {
    sweepBrowser(ctx);
    const channel = session.channel;
    const tab = ctx.state.browser.tabs.get(session.tabId);
    if (session.status === 'ended' || !channel || !tab) return;
    // The browser never sends media in `browser-tab@1`; anything unparsable, or anything before `hello`, ends it.
    const parsed = typeof data === 'string' ? parseLiveClientMessage(data) : null;
    if (parsed?.kind !== 'ok' || (channel.version === null) !== (parsed.message.type === 'hello')) {
        endSession(ctx, session, 'protocol-error', null);
        return;
    }
    const message = parsed.message;
    switch (message.type) {
        case 'hello': {
            const version = agreeLiveChannelVersion(message.versions);
            if (version === null) {
                endSession(ctx, session, 'protocol-error', null);
                return;
            }
            channel.version = version;
            send(session, { type: 'hello', version });
            sendState(ctx.state.browser, session, tab);
            send(session, pageMessage(tab));
            sendFrame(ctx, session, tab);
            return;
        }
        case 'view':
            channel.visible = message.visible;
            sendFrame(ctx, session, tab);
            return;
        case 'frame-ack':
            if (channel.unacked.delete(message.seq)) sendFrame(ctx, session, tab);
            return;
        case 'end': {
            const seconds = Math.round((time(ctx.now()) - time(session.openedAt)) / 1000);
            endSession(ctx, session, 'ended', session.memberId);
            // No route saw this end, so it is audited here, as the member's.
            ctx.state.browser.audit({
                actor: { kind: 'member', memberId: session.memberId },
                action: 'browser.session.end',
                target: { kind: 'browser-session', id: session.id, name: null },
                outcome: 'success',
                client: null,
                details: { reason: 'ended', seconds },
            });
            return;
        }
        case 'input':
            receiveInput(ctx, session, tab, message.event);
            return;
    }
}

/**
 * Attaches a WebSocket to the actor's session, after the server's gateway checked the cookie and the `Origin`. Another
 * gateway session's session is 404, like a missing one; a second attachment while one is open is 409.
 */
export function attachLiveChannel(
    ctx: EngineContext,
    actor: Actor,
    sessionId: string,
    sink: LiveChannelSink,
): LiveChannelAttach {
    noteBrowserActor(ctx, actor);
    const { browser } = ctx.state;
    const found = browser.sessions.get(sessionId);
    const session =
        found?.gatewaySessionId === actor.sessionId && found.memberId === actor.memberId ? found : undefined;
    const audit = (outcome: LiveAuditInput['outcome'], problem: ProblemDetails | null): void => {
        browser.audit({
            actor: { kind: 'member', memberId: actor.memberId },
            action: 'browser.channel.attach',
            target: session ? { kind: 'browser-session', id: session.id, name: null } : null,
            outcome,
            client: actor.client,
            details: problem && { problem: problem.code },
        });
    };
    const refuse = (problem: ProblemDetails): LiveChannelAttach => {
        audit('denied', problem);
        return { kind: 'refused', problem };
    };
    if (!session) return refuse(createProblem('not-found', { detail: 'No such live session.' }));
    if (session.status === 'ended') return refuse(createProblem('browser-session-ended'));
    if (session.channel !== null) return refuse(createProblem('live-channel-attached'));
    const channel: ChannelRecord = {
        sink,
        version: null,
        visible: true,
        unacked: new Set(),
        inputWindowStart: 0,
        inputCount: 0,
    };
    session.attached = true;
    session.channel = channel;
    let opened = false;
    return {
        kind: 'attached',
        peer: {
            opened: () => {
                if (opened) return;
                opened = true;
                audit('success', null);
            },
            receive: (data) => {
                if (session.channel === channel) receive(ctx, session, data);
            },
            closed: () => {
                if (!opened) {
                    opened = true;
                    audit('failed', null);
                }
                if (session.channel !== channel) return;
                // A reload attaches again within the attach window; a closed page frees its place and, if it was
                // controlling, hands the tab back to the agent instead of pausing it until the idle limit.
                session.channel = null;
                session.attached = false;
                session.attachBy = at(time(ctx.now()) + LIVE_SESSION_ATTACH_MS);
            },
        },
    };
}

export interface NewAgentTab {
    readonly agentId?: string | null;
    readonly chatId?: string | null;
    readonly taskId?: string | null;
    readonly runId?: string | null;
    readonly origin: string;
}

/** Agent work opened a tab: in a real engine, the agent's browser tool did. */
export function openAgentTab(ctx: EngineContext, input: NewAgentTab): BrowserTab {
    const tab: TabRecord = {
        id: ctx.newId(BrowserTabId, 'tab'),
        kind: 'agent-tab',
        browser: DEFAULT_BROWSER,
        agentId: input.agentId == null ? null : AgentId.parse(input.agentId),
        chatId: input.chatId == null ? null : ChatId.parse(input.chatId),
        taskId: input.taskId == null ? null : TaskId.parse(input.taskId),
        runId: input.runId == null ? null : RunId.parse(input.runId),
        page: { kind: 'web', origin: new URL(input.origin).origin },
        agentState: 'working',
        controller: null,
        allowed: new Set(),
        helpRequestId: null,
        openedAt: ctx.now(),
        tick: 0,
        pointer: null,
        typed: 0,
    };
    ctx.state.browser.tabs.set(tab.id, tab);
    tabChanged(ctx, tab);
    return tabView(ctx.state.browser, tab);
}

function tabRecord(ctx: EngineContext, tabId: string): TabRecord {
    const tab = ctx.state.browser.tabs.get(tabId);
    if (!tab) throw new Error(`No browser tab ${tabId}`);
    return tab;
}

/** The tab moved: by the agent, or by a link the controller followed. */
export function navigateBrowserTab(ctx: EngineContext, tabId: string, page: FakePage): void {
    sweepBrowser(ctx);
    const tab = tabRecord(ctx, tabId);
    tab.page = page.kind === 'web' ? { kind: 'web', origin: new URL(page.origin).origin } : page;
    broadcast(ctx, tab, { page: true, frame: true });
    tabChanged(ctx, tab);
}

/** The agent is stuck and asks a human. One open request per tab: asking again answers the open one. */
export function requestBrowserHelp(
    ctx: EngineContext,
    tabId: string,
    input: { readonly reason: BrowserHelpReason; readonly message: string },
): BrowserHelpRequest {
    sweepBrowser(ctx);
    const tab = tabRecord(ctx, tabId);
    if (tab.kind !== 'agent-tab') throw new Error('Only an agent’s tab asks for help');
    const open = tab.helpRequestId === null ? undefined : ctx.state.browser.helpRequests.get(tab.helpRequestId);
    if (open) return open;
    const controller = tab.controller === null ? undefined : ctx.state.browser.sessions.get(tab.controller);
    const request: BrowserHelpRequest = {
        id: ctx.newId(BrowserHelpRequestId, 'help'),
        tabId: tab.id,
        agentId: tab.agentId,
        chatId: tab.chatId,
        taskId: tab.taskId,
        runId: tab.runId,
        reason: input.reason,
        origin: tab.page.kind === 'web' ? tab.page.origin : null,
        message: toBrowserHelpMessage(input.message),
        status: controller ? 'in-progress' : 'pending',
        resolution: null,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
    };
    ctx.state.browser.helpRequests.set(request.id, request);
    tab.helpRequestId = request.id;
    if (controller) controller.helpRequestId = request.id;
    else tab.agentState = 'waiting';
    ctx.publish({ type: 'browser-help.changed', requestId: request.id });
    broadcast(ctx, tab, { state: true });
    tabChanged(ctx, tab);
    return request;
}

/** The agent's work ended or closed its tab: every session on it ends, and an open request is cancelled. */
export function closeAgentTab(ctx: EngineContext, tabId: string): void {
    const tab = tabRecord(ctx, tabId);
    for (const session of openSessionsOn(ctx.state.browser, tab.id)) endSession(ctx, session, 'tab-closed', null);
    resolveHelp(ctx, tab, 'cancelled', null);
    ctx.state.browser.tabs.delete(tab.id);
    tabChanged(ctx, tab);
}

/** The screencast's clock: ends what ran out, then sends each attached viewer the next frame it has credit for. */
export function browserTick(ctx: EngineContext): void {
    sweepBrowser(ctx);
    for (const session of ctx.state.browser.sessions.values()) {
        const tab = ctx.state.browser.tabs.get(session.tabId);
        if (session.status === 'open' && tab) sendFrame(ctx, session, tab);
    }
}

/**
 * A test-mode lever: the session behaves as if its time (`expired`) or its controller's idle limit (`idle`) ran out
 * now, so a black-box check sees the end without waiting minutes. `false` when there is no such open session.
 */
export function elapseBrowserSession(ctx: EngineContext, sessionId: string, what: 'expired' | 'idle'): boolean {
    const session = ctx.state.browser.sessions.get(sessionId);
    if (session?.status !== 'open') return false;
    const now = time(ctx.now());
    if (what === 'expired') session.endsAt = at(now);
    else session.lastInputAt = now - BROWSER_IDLE_MS;
    sweepBrowser(ctx);
    return true;
}

export function browserTabOf(ctx: EngineContext, tabId: string): BrowserTab | undefined {
    const tab = ctx.state.browser.tabs.get(tabId);
    return tab && tabView(ctx.state.browser, tab);
}
