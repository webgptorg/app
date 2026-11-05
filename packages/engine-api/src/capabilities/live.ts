import { z } from 'zod';

import { ChatId, LiveSessionId, Timestamp } from '../common';
import { defineRoute } from '../route';
import { RESERVED_CAPABILITIES } from './capability';

/**
 * Live sessions: full-duplex voice in a chat (`live-audio@1`), later video (`live-video@1`), and the owner driving one
 * engine browser tab to sign in to a site (`browser-tab@1`). Design only: every route is `draft`, no engine advertises
 * these capabilities yet, and an engine answers 404 `capability-not-supported`. The design, and what is still open for
 * the engine team, is docs/engine-integration/live-sessions.md.
 *
 * A session is opened over the API and then carried by one WebSocket on the engine origin, inside the browser's TLS
 * connection to the engine, so relays see only ciphertext, exactly as for every other request.
 */

/** Where a session's WebSocket attaches, relative to `ENGINE_API_PREFIX`. Not a route of the table yet. */
export const LIVE_CHANNEL_PATH = '/live-sessions/{sessionId}/channel';
/** Names the channel protocol only; its version is agreed in the first message, as in the tunnel (ADR 0010 §2). */
export const LIVE_CHANNEL_SUBPROTOCOL = 'ptbk-live';
/** A session whose channel has not attached by `attachBy` (this long after opening) ends unused. */
export const LIVE_SESSION_ATTACH_MS = 30_000;
/** A browser tab session ends at `endsAt`, at most this long after opening, whatever happens on the page. */
export const MAX_BROWSER_TAB_SESSION_MS = 10 * 60_000;

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

/** A configured browser tool of the engine, by the name the engine gives it. */
export const BrowserToolName = z.string().min(1).max(64);

function isCanonicalHttpsOrigin(value: string): boolean {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
}

/**
 * The site the owner signs in to, as a canonical `https` origin (`https://example.com`, lowercase, no path, no default
 * port). The engine refuses its own origins, and any origin outside its allowlist, with 403.
 */
export const BrowserOrigin = z.string().max(300).refine(isCanonicalHttpsOrigin, {
    message: 'Expected an https origin such as https://example.com',
});

/** `browser: null` is the engine's default browser. */
export const OpenBrowserTabBody = z.strictObject({
    browser: BrowserToolName.nullable(),
    origin: BrowserOrigin,
});
export type OpenBrowserTabBody = z.infer<typeof OpenBrowserTabBody>;

/** The engine opens a new tab at `origin` for this session alone; the session never reaches any other tab. */
export const BrowserTabSession = z.strictObject({
    id: LiveSessionId,
    browser: BrowserToolName,
    origin: BrowserOrigin,
    attachBy: Timestamp,
    endsAt: Timestamp,
});
export type BrowserTabSession = z.infer<typeof BrowserTabSession>;

export const LIVE_ROUTES = {
    openLiveAudioSession: defineRoute({
        id: 'openLiveAudioSession',
        method: 'POST',
        path: '/chats/{chatId}/live-audio',
        summary: 'Open a voice session in a chat; the audio flows over the live channel',
        description:
            'Design only (`live-audio@1`). The voice belongs to the chat: transcripts become its messages with their ' +
            'real authors. One live session per chat at a time. None of the offered formats is 415 ' +
            '`unsupported-media-type`.',
        permission: 'chats.write',
        capability: RESERVED_CAPABILITIES.liveAudio,
        params: LiveAudioParams,
        body: { kind: 'json', schema: OpenLiveAudioBody },
        responses: { 201: { kind: 'json', schema: LiveAudioSession } },
        problems: ['unsupported-media-type'],
        draft: true,
    }),
    openBrowserTabSession: defineRoute({
        id: 'openBrowserTabSession',
        method: 'POST',
        path: '/browser-tab-sessions',
        summary: 'Open a new engine browser tab at a site for the owner to sign in by hand',
        description:
            'Design only (`browser-tab@1`). The channel carries the tab’s frames out and the owner’s input in. The ' +
            'engine refuses its own origins, origins outside its allowlist, and pages where secrets are typed.',
        permission: 'browser.control',
        capability: RESERVED_CAPABILITIES.browserTab,
        body: { kind: 'json', schema: OpenBrowserTabBody },
        responses: { 201: { kind: 'json', schema: BrowserTabSession } },
        stepUp: true,
        draft: true,
    }),
} as const;
