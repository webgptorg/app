import { z } from 'zod';

import { openEnum, toTolerant } from '../tolerant';

/**
 * What flows inside a live session's WebSocket (`LIVE_CHANNEL_PATH`), fixed with `browser-tab@1`. Text messages are
 * control messages: JSON with a `type`, parsed strictly by the engine (anything it does not know ends the channel with
 * `protocol-error`) and tolerantly by the browser. Binary messages are media: a fixed header, then the payload.
 *
 * Nothing here carries a URL, page content beyond the frames themselves, or a credential: the channel is authenticated
 * by the gateway session cookie on the upgrade, and navigation is reported as an origin only.
 */

/** Channel protocol versions, agreed in `hello` (the highest both speak), as in the tunnel handshake (ADR 0010 §2). */
export const LIVE_CHANNEL_VERSIONS = [1] as const;
/** A text message above this many UTF-8 bytes is a protocol error. */
export const MAX_LIVE_CONTROL_MESSAGE_BYTES = 4096;
/** A binary message, header included, never exceeds this: one tunnel `DATA` frame's worth of credit. */
export const MAX_LIVE_MEDIA_BYTES = 64 * 1024;
/** Kind (u8), sequence (u32, big-endian), timestamp (float64 ms since the epoch, big-endian). */
export const LIVE_MEDIA_HEADER_BYTES = 13;
/** The engine sends no new frame while this many are unacknowledged: the screencast's credit. */
export const MAX_UNACKED_FRAMES = 2;
/** A controller sending more input events than this in one second ends the channel with `protocol-error`. */
export const MAX_LIVE_INPUT_PER_S = 120;
/** Tab coordinates and the viewer's size are CSS pixels; nothing larger is a real screen. */
export const MAX_LIVE_COORDINATE = 16_384;
export const MAX_WHEEL_DELTA = 10_000;

const Uint32 = z.int().min(0).max(0xffff_ffff);
const Coordinate = z.number().min(0).max(MAX_LIVE_COORDINATE);

/**
 * Why a session ended, sent in `end` and kept on the session. `ended`: a participant ended it. `expired`: `endsAt`
 * passed. `idle`: the controller sent no input for `BROWSER_IDLE_MS`. `not-attached`: no channel by `attachBy`.
 * `revoked`: the gateway session or the member was revoked, or lost the permission. `tab-closed`: the agent's work
 * closed the tab or ended. `engine-stopped`: the engine or its browser stopped. `protocol-error`: the client broke this
 * protocol.
 */
export const LIVE_END_REASONS = [
    'ended',
    'expired',
    'idle',
    'not-attached',
    'revoked',
    'tab-closed',
    'engine-stopped',
    'protocol-error',
] as const;
export const LiveEndReason = z.enum(LIVE_END_REASONS);
export type LiveEndReason = z.infer<typeof LiveEndReason>;

export const BROWSER_SESSION_MODES = ['watching', 'controlling'] as const;
export const BrowserSessionMode = z.enum(BROWSER_SESSION_MODES);
export type BrowserSessionMode = z.infer<typeof BrowserSessionMode>;

/**
 * What the agent does in the tab. `working`: it drives the tab. `waiting`: it asked for help and nobody controls the
 * tab yet. `paused`: a human controls it. `none`: a sign-in tab, which no agent uses.
 */
export const BROWSER_AGENT_STATES = ['working', 'waiting', 'paused', 'none'] as const;
export const BrowserAgentState = z.enum(BROWSER_AGENT_STATES);
export type BrowserAgentState = z.infer<typeof BrowserAgentState>;

function isCanonicalWebOrigin(value: string): boolean {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
}

/**
 * Where a tab is, as a canonical web origin (`https://host[:port]`, or `http://`): never a path, query or fragment,
 * which can carry tokens and personal data.
 */
// The message names no example URL: this schema ships in the UI bundle, which must contain no external URL.
export const TabOrigin = z.string().max(300).refine(isCanonicalWebOrigin, {
    message: 'Expected a canonical web origin: scheme and host, no path',
});

/**
 * Named keys a controller may press; any other key is one printable character. No function keys, no modifier other
 * than Shift: no shortcut can reach the clipboard, print, save, open devtools or a new tab.
 */
export const LIVE_NAMED_KEYS = [
    'Enter',
    'Tab',
    'Backspace',
    'Delete',
    'Escape',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
] as const;
const NAMED_KEYS: ReadonlySet<string> = new Set(LIVE_NAMED_KEYS);

/** Exactly one code point that is not a control, format, surrogate, private-use or unassigned character. */
const PRINTABLE_CHARACTER = /^[^\p{C}]$/u;

export const LiveKey = z
    .string()
    .max(16)
    .refine((key) => NAMED_KEYS.has(key) || PRINTABLE_CHARACTER.test(key), {
        message: 'Expected a named key or one printable character',
    });

export const POINTER_ACTIONS = ['move', 'down', 'up'] as const;
export const POINTER_BUTTONS = ['none', 'left', 'middle', 'right'] as const;

/** Input in tab coordinates (CSS pixels of the tab's viewport, as `state` reports it); the engine replays it. */
export const LiveInputEvent = z.discriminatedUnion('kind', [
    z.strictObject({
        kind: z.literal('pointer'),
        action: z.enum(POINTER_ACTIONS),
        x: Coordinate,
        y: Coordinate,
        button: z.enum(POINTER_BUTTONS),
        /** 2 for the second press of a double click. */
        clicks: z.int().min(0).max(3),
    }),
    z.strictObject({
        kind: z.literal('wheel'),
        x: Coordinate,
        y: Coordinate,
        deltaX: z.number().min(-MAX_WHEEL_DELTA).max(MAX_WHEEL_DELTA),
        deltaY: z.number().min(-MAX_WHEEL_DELTA).max(MAX_WHEEL_DELTA),
    }),
    z.strictObject({
        kind: z.literal('key'),
        action: z.enum(['down', 'up']),
        key: LiveKey,
        shift: z.boolean(),
    }),
]);
export type LiveInputEvent = z.infer<typeof LiveInputEvent>;

const Viewport = z.strictObject({
    width: z.int().min(1).max(MAX_LIVE_COORDINATE),
    height: z.int().min(1).max(MAX_LIVE_COORDINATE),
});

/** Browser to engine. Strict: the engine refuses anything else by ending the channel with `protocol-error`. */
export const LiveClientMessage = z.discriminatedUnion('type', [
    /** First message: every channel version the browser speaks. */
    z.strictObject({
        type: z.literal('hello'),
        versions: z
            .array(z.int().min(1).max(255))
            .min(1)
            .max(8)
            .refine((versions) => new Set(versions).size === versions.length, { message: 'Each version once' }),
    }),
    /** The viewer's drawing size, so frames are no larger than shown; `visible: false` pauses frames (hidden tab). */
    z.strictObject({
        type: z.literal('view'),
        width: Viewport.shape.width,
        height: Viewport.shape.height,
        visible: z.boolean(),
    }),
    /** The frame with this sequence number was drawn; frees one unit of `MAX_UNACKED_FRAMES` credit. */
    z.strictObject({ type: z.literal('frame-ack'), seq: Uint32 }),
    /** Only a controller's input reaches the tab; anyone else's is answered with `input-refused`. */
    z.strictObject({ type: z.literal('input'), event: LiveInputEvent }),
    z.strictObject({ type: z.literal('end') }),
]);
export type LiveClientMessage = z.infer<typeof LiveClientMessage>;

/** Why an input event did not reach the tab. The channel stays open. */
export const INPUT_REFUSED_REASONS = ['not-controlling', 'blocked', 'outside-viewport'] as const;

/**
 * Why frames stopped. `origin-not-allowed`: an origin this session may not show (outside the sign-in allowlist, or a
 * site the controller navigated to that the agent's task does not use). `browser-page`: a browser-internal page.
 * `secret-page`: the Wallet's protected entry, the password manager, or another page where secrets are shown.
 */
export const BLOCKED_REASONS = ['origin-not-allowed', 'browser-page', 'secret-page'] as const;

const engineMessages = [
    /** The version the engine chose; absent from `versions`, the engine ends with `protocol-error` instead. */
    z.strictObject({ type: z.literal('hello'), version: z.int().min(1).max(255) }),
    /** Sent after `hello` and on every change of control, agent state, watchers or viewport. */
    z.strictObject({
        type: z.literal('state'),
        mode: BrowserSessionMode,
        agent: BrowserAgentState,
        /** Other participants, the controller included. */
        others: z.int().min(0).max(64),
        viewport: Viewport,
    }),
    /** The tab is on this origin now and may be shown; frames resume if they were blocked. */
    z.strictObject({ type: z.literal('navigated'), origin: TabOrigin }),
    /** Frames stop and input is dropped until `navigated`. `origin` is withheld for browser and secret pages. */
    z.strictObject({ type: z.literal('blocked'), reason: z.enum(BLOCKED_REASONS), origin: TabOrigin.nullable() }),
    z.strictObject({ type: z.literal('input-refused'), reason: z.enum(INPUT_REFUSED_REASONS) }),
    /** The last message; the engine then closes the WebSocket with 1000 (or 1008 for `protocol-error`). */
    z.strictObject({ type: z.literal('end'), reason: LiveEndReason }),
] as const;

/** Engine to browser, as the engine must send it. */
export const LiveEngineMessage = z.discriminatedUnion('type', [...engineMessages]);
export type LiveEngineMessage = z.infer<typeof LiveEngineMessage>;

const tolerantEngineMessage = toTolerant(
    z.discriminatedUnion('type', [
        engineMessages[0],
        engineMessages[1].extend({ mode: openEnum(BROWSER_SESSION_MODES), agent: openEnum(BROWSER_AGENT_STATES) }),
        engineMessages[2],
        engineMessages[3].extend({ reason: openEnum(BLOCKED_REASONS) }),
        engineMessages[4].extend({ reason: openEnum(INPUT_REFUSED_REASONS) }),
        engineMessages[5].extend({ reason: openEnum(LIVE_END_REASONS) }),
    ]),
);
export type ReadLiveEngineMessage = z.output<typeof tolerantEngineMessage>;

const KNOWN_ENGINE_TYPES: ReadonlySet<string> = new Set(engineMessages.map((schema) => schema.shape.type.value));
const encoder = new TextEncoder();

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}

export type ParsedClientMessage =
    | { readonly kind: 'ok'; readonly message: LiveClientMessage }
    | { readonly kind: 'invalid'; readonly reason: 'too-large' | 'not-json' | 'schema' };

/** The engine's side: strict, size-checked first. Any `invalid` ends the channel with `protocol-error`. */
export function parseLiveClientMessage(text: string): ParsedClientMessage {
    if (encoder.encode(text).byteLength > MAX_LIVE_CONTROL_MESSAGE_BYTES)
        return { kind: 'invalid', reason: 'too-large' };
    const json = parseJson(text);
    if (json === undefined) return { kind: 'invalid', reason: 'not-json' };
    const parsed = LiveClientMessage.safeParse(json);
    return parsed.success ? { kind: 'ok', message: parsed.data } : { kind: 'invalid', reason: 'schema' };
}

/**
 * The browser's side: tolerant. `null` for a message to skip (an unknown type from a newer engine, or one that is not
 * an object); unknown fields are stripped and unknown enum values read as `unknown`.
 */
export function readLiveEngineMessage(text: string): ReadLiveEngineMessage | null {
    if (encoder.encode(text).byteLength > MAX_LIVE_CONTROL_MESSAGE_BYTES) return null;
    const json = parseJson(text);
    const type = typeof json === 'object' && json !== null ? (json as Record<string, unknown>)['type'] : undefined;
    if (typeof type !== 'string' || !KNOWN_ENGINE_TYPES.has(type)) return null;
    const parsed = tolerantEngineMessage.safeParse(json);
    return parsed.success ? parsed.data : null;
}

/** The highest channel version both sides speak, or `null` when they share none. */
export function agreeLiveChannelVersion(offered: readonly number[]): number | null {
    const shared = LIVE_CHANNEL_VERSIONS.filter((version) => offered.includes(version));
    return shared.length === 0 ? null : Math.max(...shared);
}

/**
 * Media kinds by their header byte. Only tab frames exist in `browser-tab@1`; 16–31 are kept for `live-audio@1` and
 * 32–47 for `live-video@1`, so one channel format serves every live capability.
 */
export const LIVE_MEDIA_KINDS = { 'tab-frame-jpeg': 1, 'tab-frame-png': 2, 'tab-frame-webp': 3 } as const;
export type LiveMediaKind = keyof typeof LIVE_MEDIA_KINDS;
const KIND_BY_BYTE: ReadonlyMap<number, LiveMediaKind> = new Map(
    Object.entries(LIVE_MEDIA_KINDS).map(([kind, byte]) => [byte, kind as LiveMediaKind]),
);

export interface LiveMedia {
    readonly kind: LiveMediaKind;
    readonly seq: number;
    /** Milliseconds since the epoch on the sender's clock, when the frame was captured. */
    readonly timestamp: number;
    readonly payload: Uint8Array;
}

export type EncodedLiveMedia =
    { readonly kind: 'ok'; readonly bytes: Uint8Array } | { readonly kind: 'too-large'; readonly bytes: number };

/** `too-large` when header and payload exceed `MAX_LIVE_MEDIA_BYTES`: the sender lowers quality or skips the frame. */
export function encodeLiveMedia(media: LiveMedia): EncodedLiveMedia {
    if (!Uint32.safeParse(media.seq).success) throw new RangeError('seq must be a u32');
    if (!Number.isFinite(media.timestamp) || media.timestamp < 0) throw new RangeError('timestamp must be finite');
    const size = LIVE_MEDIA_HEADER_BYTES + media.payload.byteLength;
    if (size > MAX_LIVE_MEDIA_BYTES) return { kind: 'too-large', bytes: size };
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, LIVE_MEDIA_KINDS[media.kind]);
    view.setUint32(1, media.seq);
    view.setFloat64(5, media.timestamp);
    bytes.set(media.payload, LIVE_MEDIA_HEADER_BYTES);
    return { kind: 'ok', bytes };
}

export type DecodedLiveMedia =
    | { readonly kind: 'ok'; readonly media: LiveMedia }
    | { readonly kind: 'invalid'; readonly reason: 'too-short' | 'too-large' | 'unknown-kind' | 'bad-timestamp' };

/** The payload is a view into `bytes`, not a copy. */
export function decodeLiveMedia(bytes: Uint8Array): DecodedLiveMedia {
    if (bytes.byteLength > MAX_LIVE_MEDIA_BYTES) return { kind: 'invalid', reason: 'too-large' };
    if (bytes.byteLength < LIVE_MEDIA_HEADER_BYTES) return { kind: 'invalid', reason: 'too-short' };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const kind = KIND_BY_BYTE.get(view.getUint8(0));
    if (kind === undefined) return { kind: 'invalid', reason: 'unknown-kind' };
    const timestamp = view.getFloat64(5);
    if (!Number.isFinite(timestamp) || timestamp < 0) return { kind: 'invalid', reason: 'bad-timestamp' };
    return {
        kind: 'ok',
        media: { kind, seq: view.getUint32(1), timestamp, payload: bytes.subarray(LIVE_MEDIA_HEADER_BYTES) },
    };
}
