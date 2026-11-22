import { z } from 'zod';

import { AgentId, ChatId, LiveSessionId, MemberId, RunId, TaskId, Timestamp } from '../common';
import { defineRoute } from '../route';
import { openEnum, toTolerant } from '../tolerant';
import { KNOWN_CAPABILITIES, RESERVED_CAPABILITIES } from './capability';
import {
    BROWSER_AGENT_STATES,
    BROWSER_SESSION_MODES,
    BrowserAgentState,
    BrowserSessionMode,
    LIVE_END_REASONS,
    LiveEndReason,
    TabOrigin,
} from './live-channel';

/**
 * Live sessions (ADR 0019, docs/engine-integration/live-sessions.md). A session is opened over the API and then
 * carried by one WebSocket on the engine origin, inside the browser's TLS connection to the engine, so relays see only
 * ciphertext, exactly as for every other request.
 *
 * `browser-tab@1` (draft): members watch the tab an agent works in, the owner takes it over or opens a fresh tab to sign
 * in to a site, and an agent that is stuck asks for help. `live-audio@1` and `live-video@1` stay reserved: their route
 * answers 404 `capability-not-supported` on every engine.
 */

/** Where a session's WebSocket attaches, relative to `ENGINE_API_PREFIX`. A WebSocket upgrade, not a route of the table. */
export const LIVE_CHANNEL_PATH = '/live-sessions/{sessionId}/channel';
/** Names the channel protocol only; its version is agreed in the first message, as in the tunnel (ADR 0010 §2). */
export const LIVE_CHANNEL_SUBPROTOCOL = 'ptbk-live';
/** A session whose channel has not attached by `attachBy` (this long after opening) ends with `not-attached`. */
export const LIVE_SESSION_ATTACH_MS = 30_000;
/** A browser session ends at `endsAt`, at most this long after opening, whatever happens on the page. */
export const MAX_BROWSER_TAB_SESSION_MS = 10 * 60_000;
/** A controller who sends no input for this long ends their session with `idle`; watchers are not idle-checked. */
export const BROWSER_IDLE_MS = 2 * 60_000;
/** Open sessions on one tab, the controller included. */
export const MAX_BROWSER_PARTICIPANTS = 5;
/** Bounds for one list; an engine with more answers the newest. */
export const MAX_BROWSER_TABS = 50;
export const MAX_BROWSER_HELP_REQUESTS = 100;
/** The agent's own words on a help request: model output, shown as text only. */
export const MAX_BROWSER_HELP_MESSAGE_LENGTH = 500;

/**
 * Proposed audio encodings, one per session for both directions. The list is open for the engine team (it depends on
 * what the voice harness takes); within `live-audio@1` it only grows.
 */
export const LIVE_AUDIO_FORMATS = ['opus-48k-mono', 'pcm16-24k-mono'] as const;
export const LiveAudioFormat = z.enum(LIVE_AUDIO_FORMATS);
export type LiveAudioFormat = z.infer<typeof LiveAudioFormat>;

export const LiveAudioParams = z.strictObject({ chatId: ChatId });

/** The formats the browser can both capture and play, in its order of preference; the engine picks one. */
export const OpenLiveAudioBody = z.strictObject({
    formats: z
        .array(LiveAudioFormat)
        .min(1)
        .max(LIVE_AUDIO_FORMATS.length)
        .refine((formats) => new Set(formats).size === formats.length, { message: 'Each format may appear once' }),
});
export type OpenLiveAudioBody = z.infer<typeof OpenLiveAudioBody>;

export const LiveAudioSession = z.strictObject({
    id: LiveSessionId,
    chatId: ChatId,
    format: LiveAudioFormat,
    attachBy: Timestamp,
});
export type LiveAudioSession = z.infer<typeof LiveAudioSession>;

const BROWSER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const BrowserTabId = z.string().regex(BROWSER_ID_PATTERN).brand<'BrowserTabId', 'inout'>();
export type BrowserTabId = z.infer<typeof BrowserTabId>;
export const BrowserHelpRequestId = z.string().regex(BROWSER_ID_PATTERN).brand<'BrowserHelpRequestId', 'inout'>();
export type BrowserHelpRequestId = z.infer<typeof BrowserHelpRequestId>;

/** A configured browser tool of the engine, by the name the engine gives it. */
export const BrowserToolName = z.string().min(1).max(64);

function isCanonicalHttpsOrigin(value: string): boolean {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    // A trailing dot names the same site as its bare host, so it could slip past an exact allowlist or own-origin match.
    return url.protocol === 'https:' && url.origin === value && !url.hostname.endsWith('.');
}

/**
 * The site the owner signs in to, as a canonical `https` origin (`https://example.com`, lowercase, no path, no default
 * port). The engine refuses its own origins, and any origin outside its sign-in allowlist, with 422
 * `browser-origin-refused`.
 */
// The message names no example URL: this schema ships in the UI bundle, which must contain no external URL.
export const BrowserOrigin = z.string().max(300).refine(isCanonicalHttpsOrigin, {
    message: 'Expected a canonical https origin: scheme and host, no path',
});

/** `browser: null` is the engine's default browser. */
export const OpenBrowserSignInBody = z.strictObject({
    browser: BrowserToolName.nullable(),
    origin: BrowserOrigin,
});
export type OpenBrowserSignInBody = z.infer<typeof OpenBrowserSignInBody>;

/** `sign-in`: a fresh tab the owner opened at an allowlisted origin. `agent-tab`: the tab an agent works in. */
export const BROWSER_SESSION_KINDS = ['sign-in', 'agent-tab'] as const;
export const BrowserSessionKind = z.enum(BROWSER_SESSION_KINDS);

export const BROWSER_SESSION_STATUSES = ['open', 'ended'] as const;

/**
 * One member's live session on one tab, bound to the gateway session that opened it: any other gateway session, the
 * same member's included, gets 404 for it, and only it may attach the channel, once at a time.
 */
export const BrowserSession = z.strictObject({
    id: LiveSessionId,
    kind: BrowserSessionKind,
    tabId: BrowserTabId,
    browser: BrowserToolName,
    mode: BrowserSessionMode,
    /** Where the tab is now; `null` while it is on a page this session may not show. */
    origin: TabOrigin.nullable(),
    status: z.enum(BROWSER_SESSION_STATUSES),
    /** Set exactly when `status` is `ended`. */
    endReason: LiveEndReason.nullable(),
    /** The help request this session's control answers: the tab's open one when control was taken. */
    helpRequestId: BrowserHelpRequestId.nullable(),
    openedAt: Timestamp,
    attachBy: Timestamp,
    endsAt: Timestamp,
});
export type BrowserSession = z.infer<typeof BrowserSession>;

const ReadBrowserSessionShape = BrowserSession.extend({
    kind: openEnum(BROWSER_SESSION_KINDS),
    mode: openEnum(BROWSER_SESSION_MODES),
    status: openEnum(BROWSER_SESSION_STATUSES),
    endReason: openEnum(LIVE_END_REASONS).nullable(),
});
const ReadBrowserSession = toTolerant(ReadBrowserSessionShape);
export type ReadBrowserSession = z.output<typeof ReadBrowserSessionShape>;

/**
 * A tab an agent works in, as a member who may watch it sees it. The links name the work it belongs to, so the UI can
 * show that work's run steps and chat messages next to the stream (narration, from the existing events).
 */
export const BrowserTab = z.strictObject({
    id: BrowserTabId,
    browser: BrowserToolName,
    agentId: AgentId.nullable(),
    chatId: ChatId.nullable(),
    taskId: TaskId.nullable(),
    runId: RunId.nullable(),
    /** `null` while the tab is on a browser-internal or secret page. */
    origin: TabOrigin.nullable(),
    agentState: BrowserAgentState,
    /** Open sessions on the tab, the controller included. */
    participants: z.int().min(0),
    helpRequestId: BrowserHelpRequestId.nullable(),
    openedAt: Timestamp,
});
export type BrowserTab = z.infer<typeof BrowserTab>;

const ReadBrowserTabShape = BrowserTab.extend({ agentState: openEnum(BROWSER_AGENT_STATES) });
export type ReadBrowserTab = z.output<typeof ReadBrowserTabShape>;

export const BROWSER_HELP_REASONS = ['login', 'captcha', 'confirmation', 'blocked', 'other'] as const;
export const BrowserHelpReason = z.enum(BROWSER_HELP_REASONS);
export type BrowserHelpReason = z.infer<typeof BrowserHelpReason>;

/** `pending`: nobody controls the tab yet. `in-progress`: a human controls it. `resolved`: see `resolution`. */
export const BROWSER_HELP_STATUSES = ['pending', 'in-progress', 'resolved'] as const;
export const BrowserHelpStatus = z.enum(BROWSER_HELP_STATUSES);
export type BrowserHelpStatus = z.infer<typeof BrowserHelpStatus>;

/**
 * How the human's part ended, which is all the agent learns of it (never frames, input or typed text).
 * `handed-back`: the controller handed the tab back. `ended`: the controller ended their session without handing back.
 * `expired` and `idle`: the session's time or the controller's idle limit ran out. `blocked-origin`: control ended
 * while the tab was on a page the session could not show, so the agent finds it there. `dismissed`: the owner
 * declined without taking control. `revoked`: the controller's session or membership was revoked. `cancelled`: the
 * agent's work ended or closed the tab first.
 */
export const BROWSER_HELP_OUTCOMES = [
    'handed-back',
    'ended',
    'expired',
    'idle',
    'blocked-origin',
    'dismissed',
    'revoked',
    'cancelled',
] as const;
export const BrowserHelpOutcome = z.enum(BROWSER_HELP_OUTCOMES);
export type BrowserHelpOutcome = z.infer<typeof BrowserHelpOutcome>;

/** What the engine hands to the waiting agent, and shows on the resolved request. */
export const BrowserHelpResolution = z.strictObject({
    outcome: BrowserHelpOutcome,
    /** Where the tab is now; `null` on a page whose origin is withheld. */
    origin: TabOrigin.nullable(),
    /** The member who ended it; `null` when the engine did (time, revocation, the agent's work). */
    by: MemberId.nullable(),
    at: Timestamp,
});
export type BrowserHelpResolution = z.infer<typeof BrowserHelpResolution>;

/** An agent stuck on a page only a human can get past. The agent waits until it is resolved. */
export const BrowserHelpRequest = z.strictObject({
    id: BrowserHelpRequestId,
    tabId: BrowserTabId,
    agentId: AgentId.nullable(),
    chatId: ChatId.nullable(),
    taskId: TaskId.nullable(),
    runId: RunId.nullable(),
    reason: BrowserHelpReason,
    /** Where the tab was when the agent asked. */
    origin: TabOrigin.nullable(),
    /** The agent's short explanation. Model output: rendered as text only, never as markup or a link. */
    message: z.string().max(MAX_BROWSER_HELP_MESSAGE_LENGTH),
    status: BrowserHelpStatus,
    /** Set exactly when `status` is `resolved`. */
    resolution: BrowserHelpResolution.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
});
export type BrowserHelpRequest = z.infer<typeof BrowserHelpRequest>;

const ReadBrowserHelpRequestShape = BrowserHelpRequest.extend({
    reason: openEnum(BROWSER_HELP_REASONS),
    status: openEnum(BROWSER_HELP_STATUSES),
    resolution: BrowserHelpResolution.extend({ outcome: openEnum(BROWSER_HELP_OUTCOMES) }).nullable(),
});
const ReadBrowserHelpRequest = toTolerant(ReadBrowserHelpRequestShape);
export type ReadBrowserHelpRequest = z.output<typeof ReadBrowserHelpRequestShape>;

export const BrowserTabList = z.strictObject({ items: z.array(BrowserTab).max(MAX_BROWSER_TABS) });
const ReadBrowserTabList = toTolerant(z.strictObject({ items: z.array(ReadBrowserTabShape).max(MAX_BROWSER_TABS) }));
export const BrowserHelpRequestList = z.strictObject({
    items: z.array(BrowserHelpRequest).max(MAX_BROWSER_HELP_REQUESTS),
});
const ReadBrowserHelpRequestList = toTolerant(
    z.strictObject({ items: z.array(ReadBrowserHelpRequestShape).max(MAX_BROWSER_HELP_REQUESTS) }),
);

/** Filters combine with AND; without one, every tab the member may watch. */
export const ListBrowserTabsQuery = z.strictObject({
    chatId: ChatId.optional(),
    taskId: TaskId.optional(),
    runId: RunId.optional(),
});
/** `open`: pending and in progress, oldest first. `resolved`: the newest resolved ones. */
export const ListBrowserHelpRequestsQuery = z.strictObject({
    status: z.enum(['open', 'resolved']).default('open'),
});

export const BrowserTabParams = z.strictObject({ tabId: BrowserTabId });
export const BrowserSessionParams = z.strictObject({ sessionId: LiveSessionId });
export const BrowserHelpRequestParams = z.strictObject({ requestId: BrowserHelpRequestId });

/** Change notifications on `GET /events`, IDs only, to members holding `browser.watch` who may see the work. */
export const BrowserTabChangedEvent = z.strictObject({ type: z.literal('browser-tab.changed'), tabId: BrowserTabId });
export const BrowserHelpChangedEvent = z.strictObject({
    type: z.literal('browser-help.changed'),
    requestId: BrowserHelpRequestId,
});

const capability = KNOWN_CAPABILITIES.browserTab;
const session = { 200: { kind: 'json', schema: BrowserSession, read: ReadBrowserSession } } as const;
const created = { 201: { kind: 'json', schema: BrowserSession, read: ReadBrowserSession } } as const;
const help = { 200: { kind: 'json', schema: BrowserHelpRequest, read: ReadBrowserHelpRequest } } as const;

export const LIVE_ROUTES = {
    openLiveAudioSession: defineRoute({
        id: 'openLiveAudioSession',
        method: 'POST',
        path: '/chats/{chatId}/live-audio',
        summary: 'Open a voice session in a chat; the audio flows over the live channel',
        description:
            'Design only (`live-audio@1`, reserved). The voice belongs to the chat: transcripts become its messages ' +
            'with their real authors. One live session per chat at a time. None of the offered formats is 415 ' +
            '`unsupported-media-type`.',
        permission: 'chats.write',
        capability: RESERVED_CAPABILITIES.liveAudio,
        params: LiveAudioParams,
        body: { kind: 'json', schema: OpenLiveAudioBody },
        responses: { 201: { kind: 'json', schema: LiveAudioSession } },
        problems: ['unsupported-media-type'],
        draft: true,
    }),
    openBrowserSignIn: defineRoute({
        id: 'openBrowserSignIn',
        method: 'POST',
        path: '/browser-sessions',
        summary: 'Open a new engine browser tab at a site for the owner to sign in by hand',
        description:
            'The session starts in control of a new tab at `origin`, which no agent uses and no other session ' +
            'reaches; ending it closes the tab, and the login stays in the browser profile. 422 ' +
            '`browser-origin-refused` for the engine’s own origins and origins outside its sign-in allowlist; 409 ' +
            '`browser-busy` while another sign-in session is open on the engine.',
        permission: 'browser.control',
        capability,
        body: { kind: 'json', schema: OpenBrowserSignInBody },
        responses: created,
        problems: ['browser-origin-refused', 'browser-busy'],
        stepUp: true,
        draft: true,
    }),
    listBrowserTabs: defineRoute({
        id: 'listBrowserTabs',
        method: 'GET',
        path: '/browser-tabs',
        summary: 'The tabs agents work in now that the member may watch',
        description:
            'Only tabs of work the member can see (its chat, task or run). Sign-in tabs are never listed. Newest ' +
            'first, at most `MAX_BROWSER_TABS`.',
        permission: 'browser.watch',
        capability,
        query: ListBrowserTabsQuery,
        responses: { 200: { kind: 'json', schema: BrowserTabList, read: ReadBrowserTabList } },
        draft: true,
    }),
    watchBrowserTab: defineRoute({
        id: 'watchBrowserTab',
        method: 'POST',
        path: '/browser-tabs/{tabId}/watch',
        summary: 'Open a session that watches an agent’s tab without controlling it',
        description:
            '409 `browser-tab-full` when `MAX_BROWSER_PARTICIPANTS` − 1 watchers are open on the tab: the last place ' +
            'is kept for a controller.',
        permission: 'browser.watch',
        capability,
        params: BrowserTabParams,
        responses: created,
        problems: ['browser-tab-full'],
        draft: true,
    }),
    controlBrowserTab: defineRoute({
        id: 'controlBrowserTab',
        method: 'POST',
        path: '/browser-tabs/{tabId}/control',
        summary: 'Open a session that takes over an agent’s tab; the agent pauses until it gets the tab back',
        description:
            'Answers the tab’s open help request, if any. 409 `browser-tab-controlled` while someone else controls ' +
            'the tab; never full, since watchers leave a place for the controller.',
        permission: 'browser.control',
        capability,
        params: BrowserTabParams,
        responses: created,
        problems: ['browser-tab-controlled'],
        stepUp: true,
        draft: true,
    }),
    getBrowserSession: defineRoute({
        id: 'getBrowserSession',
        method: 'GET',
        path: '/browser-sessions/{sessionId}',
        summary: 'One of the caller’s own browser sessions; 404 for any other gateway session’s',
        permission: 'browser.watch',
        capability,
        params: BrowserSessionParams,
        responses: session,
        draft: true,
    }),
    takeBrowserControl: defineRoute({
        id: 'takeBrowserControl',
        method: 'POST',
        path: '/browser-sessions/{sessionId}/control',
        summary: 'Take control from a watching session; the agent pauses',
        description:
            'Idempotent while the session controls. 409 `browser-tab-controlled` while someone else controls the ' +
            'tab, `browser-session-ended` once the session ended.',
        permission: 'browser.control',
        capability,
        params: BrowserSessionParams,
        responses: session,
        problems: ['browser-tab-controlled', 'browser-session-ended'],
        stepUp: true,
        draft: true,
    }),
    handBackBrowserTab: defineRoute({
        id: 'handBackBrowserTab',
        method: 'POST',
        path: '/browser-sessions/{sessionId}/hand-back',
        summary: 'Hand the tab back to the agent; the session keeps watching',
        description:
            'The agent resumes with the outcome `handed-back`. Idempotent while the session only watches. A sign-in ' +
            'session has no agent to hand back to, so it ends. 409 `browser-session-ended` once the session ended.',
        permission: 'browser.control',
        capability,
        params: BrowserSessionParams,
        responses: session,
        problems: ['browser-session-ended'],
        draft: true,
    }),
    endBrowserSession: defineRoute({
        id: 'endBrowserSession',
        method: 'POST',
        path: '/browser-sessions/{sessionId}/end',
        summary: 'End the session and close its channel; a controller’s agent resumes with the outcome `ended`',
        description: 'Idempotent: an ended session answers as it is.',
        permission: 'browser.watch',
        capability,
        params: BrowserSessionParams,
        responses: session,
        draft: true,
    }),
    listBrowserHelpRequests: defineRoute({
        id: 'listBrowserHelpRequests',
        method: 'GET',
        path: '/browser-help-requests',
        summary: 'Agents’ requests for a human to get past a page, for the work the member can see',
        permission: 'browser.watch',
        capability,
        query: ListBrowserHelpRequestsQuery,
        responses: { 200: { kind: 'json', schema: BrowserHelpRequestList, read: ReadBrowserHelpRequestList } },
        draft: true,
    }),
    getBrowserHelpRequest: defineRoute({
        id: 'getBrowserHelpRequest',
        method: 'GET',
        path: '/browser-help-requests/{requestId}',
        summary: 'One help request with its resolution',
        permission: 'browser.watch',
        capability,
        params: BrowserHelpRequestParams,
        responses: help,
        draft: true,
    }),
    dismissBrowserHelpRequest: defineRoute({
        id: 'dismissBrowserHelpRequest',
        method: 'POST',
        path: '/browser-help-requests/{requestId}/dismiss',
        summary: 'Decline without taking control; the agent resumes with the outcome `dismissed`',
        description:
            '409 `browser-tab-controlled` while someone controls the tab (they hand back instead), ' +
            '`browser-help-resolved` once it is resolved.',
        permission: 'browser.control',
        capability,
        params: BrowserHelpRequestParams,
        responses: help,
        problems: ['browser-tab-controlled', 'browser-help-resolved'],
        draft: true,
    }),
} as const;
