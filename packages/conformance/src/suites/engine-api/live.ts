import {
    BROWSER_IDLE_MS,
    ENGINE_API_ROUTES,
    ENGINE_API_ROUTE_LIST,
    KNOWN_CAPABILITIES,
    LIVE_SESSION_ATTACH_MS,
    LiveEngineMessage,
    MAX_BROWSER_TAB_SESSION_MS,
    MAX_LIVE_CONTROL_MESSAGE_BYTES,
    MAX_UNACKED_FRAMES,
    RESERVED_CAPABILITIES,
    capabilityLabel,
    decodeLiveMedia,
    isReservedCapability,
    readLiveEngineMessage,
    supports,
} from '@ptbk/engine-api';
import type { BrowserSession, ReadLiveEngineMessage } from '@ptbk/engine-api';

import type { CheckContext, ConformanceCheck } from '../../check';
import { Findings, fail, skip } from '../../check';
import { randomToken } from '../../random';
import type { LiveBrowserTarget, LiveChannelClient } from '../../target';
import { EngineApi } from './api';
import { requireCapability } from './capability-support';
import { placeholderRequest } from './requests';
import { SUITE, attempt } from './support';
import { createWorld, sessionFor } from './world';
import type { World } from './world';

const R = ENGINE_API_ROUTES;
const DESIGN = 'docs/engine-integration/live-sessions.md';
const NO_LEVERS = 'the target cannot reach the live browser (ConformanceTarget.liveBrowser)';
const STALE_STEP_UP = 'the owner session wants a fresh step-up the suite cannot give';
/** How long a check waits for a message the engine must send. */
const ANSWER_MS = 3_000;
/** How long a check listens for something the engine must not send. */
const QUIET_MS = 750;
const WATCH_PERMISSIONS = ['browser.watch', 'agents.read', 'chats.read', 'tasks.read', 'runs.read'] as const;

interface Live {
    readonly ctx: CheckContext;
    readonly world: World;
    readonly owner: EngineApi;
    readonly lb: LiveBrowserTarget;
    readonly findings: Findings;
    /** A fresh origin for this run, so tabs of earlier runs never match. */
    origin(label: string): string;
}

async function live(ctx: CheckContext): Promise<Live> {
    const world = await createWorld(ctx);
    await requireCapability(world, KNOWN_CAPABILITIES.browserTab);
    const lb = ctx.target.liveBrowser;
    if (lb === undefined) skip(NO_LEVERS);
    const run = ctx.runId.toLowerCase().replace(/[^a-z0-9-]/g, '');
    return {
        ctx,
        world,
        owner: world.owner,
        lb,
        findings: new Findings(),
        origin: (label) => `https://${label}-${run}.conformance.invalid`,
    };
}

/** Every session a check opens is ended afterwards, whatever happened. */
function track(t: Live, api: EngineApi, session: BrowserSession): BrowserSession {
    t.ctx.resources.defer((signal) =>
        api.withSignal(signal).send(R.endBrowserSession, { params: { sessionId: session.id } }),
    );
    return session;
}

async function agentTab(t: Live, label: string): Promise<string> {
    return t.lb.openAgentTab(t.origin(label));
}

async function watch(t: Live, api: EngineApi, tabId: string): Promise<BrowserSession> {
    return track(t, api, await api.ok(R.watchBrowserTab, { params: { tabId } }));
}

/** A controlling session, or a skip when the owner's session cannot satisfy step-up. */
async function control(t: Live, tabId: string, api: EngineApi = t.owner): Promise<BrowserSession> {
    const result = await api.call(R.controlBrowserTab, { params: { tabId } });
    if (result.kind === 'problem' && result.problem.code === 'step-up-required') skip(STALE_STEP_UP);
    if (result.kind === 'problem') fail(`POST /browser-tabs/{tabId}/control: answered ${result.problem.code}`);
    return track(t, api, result.data);
}

async function signIn(t: Live): Promise<BrowserSession> {
    const result = await t.owner.call(R.openBrowserSignIn, { body: { browser: null, origin: t.lb.signInOrigin } });
    if (result.kind === 'problem' && result.problem.code === 'step-up-required') skip(STALE_STEP_UP);
    if (result.kind === 'problem') fail(`POST /browser-sessions: answered ${result.problem.code}`);
    return track(t, t.owner, result.data);
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}

/**
 * A channel as a check reads it: every text message must be the engine's strict schema and every binary one valid
 * media within the 64 KiB cap, or the check records a finding.
 */
class Viewer {
    readonly messages: ReadLiveEngineMessage[] = [];
    frames = 0;
    closed: number | null = null;
    /** Sequence numbers of frames not acknowledged yet. */
    readonly unacked: number[] = [];
    readonly #channel: LiveChannelClient;
    readonly #findings: Findings;

    constructor(channel: LiveChannelClient, findings: Findings) {
        this.#channel = channel;
        this.#findings = findings;
    }

    send(message: unknown): void {
        this.#channel.send(JSON.stringify(message));
    }

    sendRaw(data: string | Uint8Array): void {
        this.#channel.send(data);
    }

    close(): void {
        this.#channel.close();
    }

    ack(): void {
        for (const seq of this.unacked.splice(0)) this.send({ type: 'frame-ack', seq });
    }

    /** Reads until `until` matches a message, the channel closes, or `ms` passes; answers the match or `null`. */
    async read(until: (message: ReadLiveEngineMessage) => boolean, ms: number): Promise<ReadLiveEngineMessage | null> {
        const deadline = Date.now() + ms;
        for (;;) {
            const left = deadline - Date.now();
            if (left <= 0 || this.closed !== null) return null;
            const event = await this.#channel.next(left);
            if (event === null) return null;
            if (event.kind === 'closed') {
                this.closed = event.code;
                return null;
            }
            if (event.kind === 'binary') {
                const media = decodeLiveMedia(event.bytes);
                if (media.kind === 'ok') {
                    this.frames++;
                    this.unacked.push(media.media.seq);
                } else {
                    this.#findings.add(`live channel: a binary message is not media within 64 KiB (${media.reason})`);
                }
                continue;
            }
            if (!LiveEngineMessage.safeParse(parseJson(event.text)).success) {
                this.#findings.add('live channel: the engine sent a text message outside the contract');
            }
            const message = readLiveEngineMessage(event.text);
            if (message === null) continue;
            this.messages.push(message);
            if (until(message)) return message;
        }
    }

    /** Frames and messages that arrive while the check only listens. */
    async listen(ms: number): Promise<{ readonly frames: number; readonly messages: ReadLiveEngineMessage[] }> {
        const frames = this.frames;
        const count = this.messages.length;
        await this.read(() => false, ms);
        return { frames: this.frames - frames, messages: this.messages.slice(count) };
    }

    end(): Promise<ReadLiveEngineMessage | null> {
        return this.read((message) => message.type === 'end', ANSWER_MS);
    }
}

async function open(t: Live, session: BrowserSession, api: EngineApi = t.owner): Promise<Viewer> {
    const opened = await t.lb.openChannel(session.id, api.credential, t.ctx.target.baseUrl.origin);
    if (opened.kind === 'refused') fail(`live channel: the upgrade was refused with ${String(opened.status)}`);
    const viewer = new Viewer(opened.channel, t.findings);
    t.ctx.resources.defer(() => {
        viewer.close();
        return Promise.resolve();
    });
    return viewer;
}

/** Opens the channel and says hello; answers once the engine said where the tab is. */
async function join(t: Live, session: BrowserSession, api: EngineApi = t.owner): Promise<Viewer> {
    const viewer = await open(t, session, api);
    viewer.send({ type: 'hello', versions: [1] });
    const page = await viewer.read((message) => message.type === 'navigated' || message.type === 'blocked', ANSWER_MS);
    if (page === null) fail('live channel: no navigated or blocked after hello');
    return viewer;
}

const pointer = (x = 10, y = 10) => ({ kind: 'pointer', action: 'down', x, y, button: 'left', clicks: 1 }) as const;

/** The channel refused a message: it ended with protocol-error, or the engine closed it with an error code. */
async function expectProtocolEnd(viewer: Viewer, what: string, findings: Findings): Promise<void> {
    const end = await viewer.end();
    if (end?.type === 'end' && end.reason === 'protocol-error') return;
    if (end === null && viewer.closed !== null && viewer.closed !== 1000) return;
    findings.add(`live channel: ${what} did not end the channel with protocol-error`);
}

/** The refused upgrade's status, or a finding when the engine let it through. */
async function expectRefused(
    t: Live,
    sessionId: string,
    credential: EngineApi['credential'],
    origin: string,
    status: number,
    what: string,
): Promise<void> {
    const opened = await t.lb.openChannel(sessionId, credential, origin);
    if (opened.kind === 'open') {
        opened.channel.close();
        t.findings.add(`live channel: attached ${what}`);
    } else if (opened.status !== status) {
        t.findings.add(`live channel: ${what} got ${String(opened.status)}, not ${String(status)}`);
    }
}

async function tabOf(t: Live, tabId: string) {
    return (await t.owner.ok(R.listBrowserTabs, { query: {} })).items.find(({ id }) => id === tabId);
}

/**
 * Live audio and video are designed but not specified (ADR 0019): an engine must not advertise them and their route
 * stays inert. `browser-tab@1` is a draft capability whose checks run when the engine advertises it and the target can
 * reach its channel and test-mode levers (`ConformanceTarget.liveBrowser`), and skip otherwise.
 */
export const LIVE_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.live.reserved',
        suite: SUITE,
        title: 'The engine advertises no reserved live capability, and their routes answer 404 capability-not-supported',
        async run(ctx) {
            const world = await createWorld(ctx);
            const engine = await world.engine();
            const findings = new Findings();
            for (const capability of Object.values(RESERVED_CAPABILITIES)) {
                if (supports(engine, capability)) {
                    findings.add(
                        `GET /engine advertises ${capabilityLabel(capability)}, which is design only (${DESIGN})`,
                    );
                }
            }
            for (const route of ENGINE_API_ROUTE_LIST) {
                if (route.capability === undefined || !isReservedCapability(route.capability)) continue;
                await attempt(findings, async () => {
                    await world.owner.problem(
                        route,
                        await placeholderRequest(route, world),
                        'capability-not-supported',
                    );
                });
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.live-audio.session',
        suite: SUITE,
        title: 'A voice session opens in a chat and its channel carries audio both ways (live-audio@1, not written yet)',
        async run(ctx) {
            await requireCapability(await createWorld(ctx), RESERVED_CAPABILITIES.liveAudio);
            skip('not-implemented');
        },
    },
    {
        id: 'engine-api.browser-tab.session-binding',
        suite: SUITE,
        title: 'A browser session belongs to the gateway session that opened it: any other one gets 404, on the API and the channel',
        async run(ctx) {
            const t = await live(ctx);
            const session = await watch(t, t.owner, await agentTab(t, 'binding'));
            const other = await sessionFor(ctx, { kind: 'owner' }, 'a second owner session tries the first one’s');
            const params = { params: { sessionId: session.id } };
            for (const route of [R.getBrowserSession, R.handBackBrowserTab, R.endBrowserSession]) {
                await attempt(t.findings, async () => {
                    await other.problem(route, params, 'not-found');
                });
            }
            const taken = await other.call(R.takeBrowserControl, params);
            if (taken.kind === 'ok' || !['not-found', 'step-up-required'].includes(taken.problem.code)) {
                t.findings.add(
                    'POST /browser-sessions/{sessionId}/control: another gateway session reached the session',
                );
            }
            await expectRefused(
                t,
                session.id,
                other.credential,
                ctx.target.baseUrl.origin,
                404,
                'with another gateway session',
            );
            if ((await t.owner.ok(R.getBrowserSession, params)).status !== 'open') {
                t.findings.add('GET /browser-sessions/{sessionId}: the session ended because another session tried it');
            }
            return t.findings.outcome();
        },
    },
    {
        id: 'engine-api.browser-tab.channel-auth',
        suite: SUITE,
        title: 'The live channel needs the session cookie and the engine’s own Origin, and attaches once at a time',
        async run(ctx) {
            const t = await live(ctx);
            const session = await watch(t, t.owner, await agentTab(t, 'channel-auth'));
            const own = ctx.target.baseUrl.origin;
            await expectRefused(t, session.id, null, own, 401, 'without a session cookie');
            await expectRefused(
                t,
                session.id,
                t.owner.credential,
                'https://attacker.invalid',
                403,
                'with a foreign Origin',
            );
            const first = await open(t, session);
            await expectRefused(t, session.id, t.owner.credential, own, 409, 'a second time while one is open');
            first.close();
            await first.read(() => false, QUIET_MS);
            await attempt(t.findings, async () => {
                (await join(t, session)).close();
            });
            return t.findings.outcome();
        },
    },
    {
        id: 'engine-api.browser-tab.step-up',
        suite: SUITE,
        title: 'Opening a sign-in tab and taking control of a tab need a fresh step-up; watching does not',
        async run(ctx) {
            const t = await live(ctx);
            if (t.lb.staleOwnerSession === undefined) skip('the target provides no owner session with a stale step-up');
            const stale = new EngineApi(ctx, await t.lb.staleOwnerSession());
            const tabId = await agentTab(t, 'step-up');
            await attempt(t.findings, async () => {
                await stale.problem(
                    R.openBrowserSignIn,
                    { body: { browser: null, origin: t.lb.signInOrigin } },
                    'step-up-required',
                );
            });
            await attempt(t.findings, async () => {
                await stale.problem(R.controlBrowserTab, { params: { tabId } }, 'step-up-required');
            });
            const watching = await watch(t, stale, tabId);
            await attempt(t.findings, async () => {
                await stale.problem(R.takeBrowserControl, { params: { sessionId: watching.id } }, 'step-up-required');
            });
            return t.findings.outcome();
        },
    },
    {
        id: 'engine-api.browser-tab.channel-handshake',
        suite: SUITE,
        title: 'After hello the engine sends its version, the state and the origin, then frames within 64 KiB and its frame credit',
        async run(ctx) {
            const t = await live(ctx);
            const session = await watch(t, t.owner, await agentTab(t, 'handshake'));
            const viewer = await open(t, session);
            viewer.send({ type: 'hello', versions: [1] });
            const hello = await viewer.read((message) => message.type === 'hello', ANSWER_MS);
            if (hello?.type !== 'hello' || hello.version !== 1) t.findings.add('live channel: no hello with version 1');
            const state = await viewer.read((message) => message.type === 'state', ANSWER_MS);
            if (state?.type !== 'state') fail('live channel: no state after hello');
            if (state.mode !== 'watching')
                t.findings.add(`live channel: a watching session’s state says ${state.mode}`);
            const page = await viewer.read((message) => message.type === 'navigated', ANSWER_MS);
            if (page?.type !== 'navigated' || page.origin !== t.origin('handshake')) {
                t.findings.add('live channel: navigated does not name the tab’s origin');
            }
            await viewer.listen(QUIET_MS * 2);
            if (viewer.unacked.length > MAX_UNACKED_FRAMES) {
                t.findings.add(
                    `live channel: ${String(viewer.unacked.length)} frames sent without an ack (at most ${String(MAX_UNACKED_FRAMES)})`,
                );
            }
            return t.findings.outcome();
        },
    },
    {
        id: 'engine-api.browser-tab.watcher-input',
        suite: SUITE,
        title: 'A watcher cannot control: its input is refused or ends the channel, and it cannot take control without browser.control',
        async run(ctx) {
            const t = await live(ctx);
            const member = await sessionFor(ctx, { kind: 'member', permissions: [...WATCH_PERMISSIONS] }, 'a watcher');
            const tabId = await agentTab(t, 'watcher');
            const session = await watch(t, member, tabId);
            const viewer = await join(t, session, member);
            viewer.send({ type: 'input', event: pointer() });
            const answer = await viewer.read(
                (message) => message.type === 'input-refused' || message.type === 'end',
                ANSWER_MS,
            );
            if (answer === null && viewer.closed === null) {
                t.findings.add('live channel: a watcher’s input was neither refused nor did it end the channel');
            }
            await attempt(t.findings, async () => {
                await member.problem(R.takeBrowserControl, { params: { sessionId: session.id } }, 'forbidden');
                await member.problem(R.controlBrowserTab, { params: { tabId } }, 'forbidden');
            });
            if ((await tabOf(t, tabId))?.agentState !== 'working') {
                t.findings.add('GET /browser-tabs: a watcher’s input paused the agent');
            }
            return t.findings.outcome();
        },
    },
    {
        id: 'engine-api.browser-tab.single-controller',
        suite: SUITE,
        title: 'One controller per tab: the agent pauses while it controls, others get 409, handing back resumes the agent',
        async run(ctx) {
            const t = await live(ctx);
            const tabId = await agentTab(t, 'controller');
            const controlling = await control(t, tabId);
            if (controlling.mode !== 'controlling')
                t.findings.add('POST /browser-tabs/{tabId}/control: not controlling');
            if ((await tabOf(t, tabId))?.agentState !== 'paused') {
                t.findings.add('GET /browser-tabs: the agent is not paused while a human controls the tab');
            }
            const second = await sessionFor(ctx, { kind: 'owner' }, 'a second owner session competes for control');
            await attempt(t.findings, async () => {
                await second.problem(R.controlBrowserTab, { params: { tabId } }, 'browser-tab-controlled');
            });
            const watching = await watch(t, second, tabId);
            await attempt(t.findings, async () => {
                await second.problem(
                    R.takeBrowserControl,
                    { params: { sessionId: watching.id } },
                    'browser-tab-controlled',
                );
            });
            const handed = await t.owner.ok(R.handBackBrowserTab, { params: { sessionId: controlling.id } });
            if (handed.mode !== 'watching' || handed.status !== 'open') {
                t.findings.add('POST /browser-sessions/{sessionId}/hand-back: the session does not keep watching');
            }
            if ((await tabOf(t, tabId))?.agentState !== 'working') {
                t.findings.add('GET /browser-tabs: handing back did not resume the agent');
            }
            return t.findings.outcome();
        },
    },
    {
        id: 'engine-api.browser-tab.blocked-pages',
        suite: SUITE,
        title: 'Frames stop and input is dropped on secret and browser pages, and on origins a controller may not reach',
        async run(ctx) {
            const t = await live(ctx);
            const tabId = await agentTab(t, 'blocked');
            const viewer = await join(t, await control(t, tabId));
            for (const page of [{ kind: 'secret-page' }, { kind: 'browser-page' }] as const) {
                await t.lb.navigate(tabId, page);
                const blocked = await viewer.read((message) => message.type === 'blocked', ANSWER_MS);
                if (blocked?.type !== 'blocked') {
                    t.findings.add(`live channel: no blocked on a ${page.kind}`);
                    continue;
                }
                if (blocked.origin !== null) t.findings.add(`live channel: blocked on a ${page.kind} names an origin`);
                viewer.ack();
                viewer.send({ type: 'input', event: pointer() });
                const after = await viewer.listen(QUIET_MS);
                if (after.frames > 0) t.findings.add(`live channel: a frame arrived on a ${page.kind}`);
                if (!after.messages.some((message) => message.type === 'input-refused')) {
                    t.findings.add(`live channel: input on a ${page.kind} was not refused`);
                }
            }
            await t.lb.navigate(tabId, { kind: 'web', origin: t.origin('elsewhere') });
            const off = await viewer.read((message) => message.type === 'blocked', ANSWER_MS);
            if (off?.type !== 'blocked' || off.reason !== 'origin-not-allowed') {
                t.findings.add('live channel: a controller on another origin got no blocked origin-not-allowed');
            }
            viewer.ack();
            if ((await viewer.listen(QUIET_MS)).frames > 0)
                t.findings.add('live channel: a frame arrived off the origin');
            await t.lb.navigate(tabId, { kind: 'web', origin: t.origin('blocked') });
            if ((await viewer.read((message) => message.type === 'navigated', ANSWER_MS)) === null) {
                t.findings.add('live channel: no navigated once the tab was back on its origin');
            }
            return t.findings.outcome();
        },
    },
    {
        id: 'engine-api.browser-tab.protocol-errors',
        suite: SUITE,
        title: 'Anything outside the channel protocol ends the channel: before hello, unknown messages, out-of-schema input, oversized text',
        async run(ctx) {
            const t = await live(ctx);
            const tabId = await agentTab(t, 'protocol');
            const ctrlKey = { kind: 'key', action: 'down', key: 'v', ctrl: true, shift: false };
            const cases: readonly (readonly [string, boolean, string | Uint8Array])[] = [
                ['a message before hello', false, JSON.stringify({ type: 'frame-ack', seq: 0 })],
                ['an unknown message', true, JSON.stringify({ type: 'eval', code: '1' })],
                ['input with a Ctrl modifier', true, JSON.stringify({ type: 'input', event: ctrlKey })],
                [
                    'a navigation',
                    true,
                    JSON.stringify({ type: 'input', event: { kind: 'navigate', url: t.origin('x') } }),
                ],
                ['a pointer off the tab', true, JSON.stringify({ type: 'input', event: pointer(-5, 10) })],
                [
                    'text over 4 KiB',
                    true,
                    // Valid apart from its size, so only a size limit refuses it.
                    `{"type":"frame-ack",${' '.repeat(MAX_LIVE_CONTROL_MESSAGE_BYTES)}"seq":0}`,
                ],
                ['binary media from the browser', true, new Uint8Array(32)],
            ];
            for (const [what, hello, data] of cases) {
                await attempt(t.findings, async () => {
                    const session = await watch(t, t.owner, tabId);
                    const viewer = hello ? await join(t, session) : await open(t, session);
                    viewer.sendRaw(data);
                    await expectProtocolEnd(viewer, what, t.findings);
                });
            }
            return t.findings.outcome();
        },
    },
    {
        id: 'engine-api.browser-tab.time-limits',
        suite: SUITE,
        title: 'A session ends at endsAt (expired) and a controller after its idle limit (idle); attachBy and endsAt are within their limits',
        async run(ctx) {
            const t = await live(ctx);
            const tabId = await agentTab(t, 'time');
            const watching = await watch(t, t.owner, tabId);
            const opened = Date.parse(watching.openedAt);
            if (Date.parse(watching.endsAt) - opened > MAX_BROWSER_TAB_SESSION_MS) {
                t.findings.add('POST /browser-tabs/{tabId}/watch: endsAt is more than 10 minutes after opening');
            }
            if (Date.parse(watching.attachBy) - opened > LIVE_SESSION_ATTACH_MS) {
                t.findings.add('POST /browser-tabs/{tabId}/watch: attachBy is more than 30 s after opening');
            }
            const viewer = await join(t, watching);
            await t.lb.elapse(watching.id, 'expired');
            const end = await viewer.end();
            if (end?.type !== 'end' || end.reason !== 'expired')
                t.findings.add('live channel: no end expired at endsAt');
            const after = await t.owner.ok(R.getBrowserSession, { params: { sessionId: watching.id } });
            if (after.endReason !== 'expired') {
                t.findings.add('GET /browser-sessions/{sessionId}: an expired session does not say expired');
            }
            const requestId = await t.lb.requestHelp(tabId, 'login', 'Please sign in.');
            const controlling = await control(t, tabId);
            const controller = await join(t, controlling);
            await t.lb.elapse(controlling.id, 'idle');
            const idle = await controller.end();
            if (idle?.type !== 'end' || idle.reason !== 'idle') {
                t.findings.add(
                    `live channel: no end idle after ${String(BROWSER_IDLE_MS / 60_000)} minutes without input`,
                );
            }
            const request = await t.owner.ok(R.getBrowserHelpRequest, { params: { requestId } });
            if (request.resolution?.outcome !== 'idle') {
                t.findings.add(
                    'GET /browser-help-requests/{requestId}: an idle end does not resolve the request as idle',
                );
            }
            return t.findings.outcome();
        },
    },
    {
        id: 'engine-api.browser-tab.audit-metadata',
        suite: SUITE,
        title: 'Browser sessions are audited as metadata only: never the text typed into the tab',
        async run(ctx) {
            const t = await live(ctx);
            if (!supports(await t.world.engine(), KNOWN_CAPABILITIES.audit))
                skip('the engine does not advertise audit@1');
            const session = await signIn(t);
            const viewer = await join(t, session);
            const canary = randomToken(ctx.random, 16).toLowerCase();
            for (const key of canary) {
                viewer.send({ type: 'input', event: { kind: 'key', action: 'down', key, shift: false } });
                viewer.send({ type: 'input', event: { kind: 'key', action: 'up', key, shift: false } });
            }
            await viewer.listen(QUIET_MS);
            await t.owner.ok(R.endBrowserSession, { params: { sessionId: session.id } });
            const raw = await t.owner.send(R.listAuditEntries, { query: { limit: 100 } });
            if (new TextDecoder().decode(raw.bytes).includes(canary)) {
                t.findings.add('GET /audit: the text typed into the tab is in the audit log');
            }
            const entries = await t.owner.ok(R.listAuditEntries, { query: { limit: 100 } });
            if (!entries.items.some((entry) => entry.action.startsWith('browser.'))) {
                t.findings.add('GET /audit: a browser sign-in session left no browser.* entry');
            }
            return t.findings.outcome();
        },
    },
    {
        id: 'engine-api.browser-tab.help-requests',
        suite: SUITE,
        title: 'A help request waits pending, goes in progress under control, and resolves with its outcome: handed-back, dismissed',
        async run(ctx) {
            const t = await live(ctx);
            const me = await t.world.me();
            const tabId = await agentTab(t, 'help');
            const requestId = await t.lb.requestHelp(tabId, 'captcha', 'A captcha blocks the checkout.');
            const read = () => t.owner.ok(R.getBrowserHelpRequest, { params: { requestId } });
            const pending = await read();
            if (pending.status !== 'pending' || pending.reason !== 'captcha' || pending.tabId !== tabId) {
                t.findings.add('GET /browser-help-requests/{requestId}: a new request is not pending with its reason');
            }
            const open = await t.owner.ok(R.listBrowserHelpRequests, { query: { status: 'open' } });
            if (!open.items.some(({ id }) => id === requestId)) {
                t.findings.add('GET /browser-help-requests: a pending request is not listed as open');
            }
            const tab = await tabOf(t, tabId);
            if (tab?.agentState !== 'waiting' || tab.helpRequestId !== requestId) {
                t.findings.add('GET /browser-tabs: a tab with a pending request is not waiting for it');
            }
            const controlling = await control(t, tabId);
            if (controlling.helpRequestId !== requestId) {
                t.findings.add('POST /browser-tabs/{tabId}/control: the session does not answer the open request');
            }
            if ((await read()).status !== 'in-progress') {
                t.findings.add('GET /browser-help-requests/{requestId}: not in progress under control');
            }
            await attempt(t.findings, async () => {
                await t.owner.problem(R.dismissBrowserHelpRequest, { params: { requestId } }, 'browser-tab-controlled');
            });
            await t.owner.ok(R.handBackBrowserTab, { params: { sessionId: controlling.id } });
            const resolved = await read();
            if (resolved.resolution?.outcome !== 'handed-back' || resolved.resolution.by !== me.memberId) {
                t.findings.add(
                    'GET /browser-help-requests/{requestId}: handing back does not resolve it as handed-back',
                );
            }
            await attempt(t.findings, async () => {
                await t.owner.problem(R.dismissBrowserHelpRequest, { params: { requestId } }, 'browser-help-resolved');
            });
            const secondId = await t.lb.requestHelp(tabId, 'confirmation', 'Confirm the order?');
            const dismissed = await t.owner.ok(R.dismissBrowserHelpRequest, { params: { requestId: secondId } });
            if (dismissed.resolution?.outcome !== 'dismissed') {
                t.findings.add('POST /browser-help-requests/{requestId}/dismiss: not resolved as dismissed');
            }
            const resolvedList = await t.owner.ok(R.listBrowserHelpRequests, { query: { status: 'resolved' } });
            if (!resolvedList.items.some(({ id }) => id === secondId)) {
                t.findings.add('GET /browser-help-requests?status=resolved: a dismissed request is not listed');
            }
            return t.findings.outcome();
        },
    },
];
