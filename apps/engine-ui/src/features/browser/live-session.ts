import { decodeLiveMedia, LIVE_CHANNEL_VERSIONS, MAX_LIVE_COORDINATE, readLiveEngineMessage } from '@ptbk/engine-api';
import type {
    EngineApiClient,
    LiveClientMessage,
    LiveInputEvent,
    LiveMedia,
    ReadBrowserSession,
    ReadLiveEngineMessage,
} from '@ptbk/engine-api';

import type { LiveChannelConnection, OpenLiveChannel } from './live-channel';
import { createInputBudget } from './live-input';
import type { TabViewport } from './live-input';

type StateMessage = Extract<ReadLiveEngineMessage, { readonly type: 'state' }>;
type BlockedMessage = Extract<ReadLiveEngineMessage, { readonly type: 'blocked' }>;

export type LiveConnection = 'connecting' | 'open' | 'reconnecting' | 'closed';
export type LiveMode = ReadBrowserSession['mode'];
export type LiveAgentState = StateMessage['agent'];
export type LiveEndReason = NonNullable<ReadBrowserSession['endReason']>;

export interface LiveBlock {
    readonly reason: BlockedMessage['reason'];
    /** Withheld by the engine for browser and secret pages. */
    readonly origin: string | null;
}

/** Everything the viewer and the shell's indicator show of one session; replaced, never mutated. */
export interface LiveView {
    /** As the engine last answered for it over the API. */
    readonly session: ReadBrowserSession;
    readonly connection: LiveConnection;
    readonly mode: LiveMode;
    /** `null` until the channel's first `state`. */
    readonly agent: LiveAgentState | null;
    readonly others: number;
    readonly viewport: TabViewport | null;
    /** The origin the engine reports; never a URL. */
    readonly origin: string | null;
    readonly blocked: LiveBlock | null;
    /** Set once the session ended, by either side; the channel is then closed for good. */
    readonly endReason: LiveEndReason | null;
    /** A frame of the current page is on the canvas. */
    readonly hasFrame: boolean;
}

/** Draws one frame where the member sees it; the session acknowledges the frame once the promise settles. */
export interface FrameDrawer {
    readonly draw: (media: LiveMedia) => Promise<void>;
    /** Frames stopped (a blocked page): nothing of the previous page stays on screen. */
    readonly clear: () => void;
}

export interface ViewSize {
    readonly width: number;
    readonly height: number;
}

export interface LiveSessionDeps {
    readonly engineApi: EngineApiClient;
    readonly openChannel: OpenLiveChannel;
    readonly now?: () => number;
    /** Returns a cancel; defaults to `setTimeout`. */
    readonly schedule?: (callback: () => void, ms: number) => () => void;
}

export interface LiveSession {
    readonly id: ReadBrowserSession['id'];
    readonly tabId: ReadBrowserSession['tabId'];
    readonly subscribe: (listener: () => void) => () => void;
    readonly getView: () => LiveView;
    /** Frames go to `drawer` while attached; detached, the engine pauses them (`view { visible: false }`). */
    readonly attach: (drawer: FrameDrawer, size: ViewSize) => () => void;
    readonly resize: (size: ViewSize) => void;
    /** The page itself was hidden or shown (`visibilitychange`). */
    readonly setPageVisible: (visible: boolean) => void;
    /**
     * Sends one input event, only while this session controls the tab and its page may be shown. Nothing of it is
     * kept: what the member types goes to the channel and nowhere else. `essential` presses and keys outlast moves
     * under the input rate limit.
     */
    readonly input: (event: LiveInputEvent, essential: boolean) => boolean;
    /** The engine answered a control change or a read for this session. */
    readonly update: (session: ReadBrowserSession) => void;
    /** Ends it on the engine (idempotent) and closes the channel. */
    readonly end: () => Promise<void>;
    /** Closes the channel and stops reconnecting, leaving the session to its own end on the engine. */
    readonly dispose: () => void;
}

/** After a dropped channel the same gateway session may attach again until the session ends. */
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;
const API_TIMEOUT_MS = 15_000;

function clampSize(value: number): number {
    return Math.min(MAX_LIVE_COORDINATE, Math.max(1, Math.round(value)));
}

const defaultSchedule = (callback: () => void, ms: number) => {
    const handle = setTimeout(callback, ms);
    return () => {
        clearTimeout(handle);
    };
};

/**
 * One member's live session on one tab: the channel's handshake, frames with their acknowledgements, input while in
 * control, and reconnection within the session. The engine is the authority on mode, page and end; this only mirrors
 * what it says.
 */
export function createLiveSession(deps: LiveSessionDeps, opened: ReadBrowserSession): LiveSession {
    const now = deps.now ?? Date.now;
    const schedule = deps.schedule ?? defaultSchedule;
    const listeners = new Set<() => void>();
    const budget = createInputBudget(now);
    let view: LiveView = {
        session: opened,
        connection: opened.status === 'open' ? 'connecting' : 'closed',
        mode: opened.mode,
        agent: null,
        others: 0,
        viewport: null,
        origin: opened.origin,
        blocked: null,
        endReason: opened.status === 'open' ? null : (opened.endReason ?? 'unknown'),
        hasFrame: false,
    };
    let connection: LiveChannelConnection | null = null;
    // Each channel gets a number; late callbacks of an older one change nothing.
    let generation = 0;
    let attempts = 0;
    let cancelRetry: (() => void) | null = null;
    let drawer: FrameDrawer | null = null;
    let size: ViewSize = { width: 1, height: 1 };
    let pageVisible = true;
    let drawing = false;
    let queued: { readonly media: LiveMedia; readonly generation: number } | null = null;
    let disposed = false;

    const set = (change: Partial<LiveView>) => {
        view = { ...view, ...change };
        for (const listener of [...listeners]) listener();
    };
    const send = (message: LiveClientMessage) => {
        connection?.send(JSON.stringify(message));
    };
    const sendView = () => {
        if (view.connection !== 'open') return;
        send({
            type: 'view',
            width: clampSize(size.width),
            height: clampSize(size.height),
            visible: drawer !== null && pageVisible,
        });
    };
    const ack = (seq: number, of: number) => {
        if (of === generation) send({ type: 'frame-ack', seq });
    };

    const closeChannel = () => {
        generation += 1;
        const open = connection;
        connection = null;
        queued = null;
        open?.close();
    };

    const finish = (reason: LiveEndReason) => {
        if (view.endReason !== null) return;
        cancelRetry?.();
        cancelRetry = null;
        closeChannel();
        drawer?.clear();
        set({
            endReason: reason,
            connection: 'closed',
            hasFrame: false,
            session: { ...view.session, status: 'ended', endReason: reason },
        });
    };

    const paint = (media: LiveMedia, of: number) => {
        const target = drawer;
        if (target === null || view.blocked !== null || !pageVisible) {
            ack(media.seq, of);
            return;
        }
        drawing = true;
        void target
            .draw(media)
            .then(
                () => {
                    if (of === generation && drawer === target && !view.hasFrame && view.blocked === null) {
                        set({ hasFrame: true });
                    }
                },
                () => undefined,
            )
            .finally(() => {
                drawing = false;
                ack(media.seq, of);
                const next = queued;
                queued = null;
                if (next !== null) paint(next.media, next.generation);
            });
    };

    const receiveMedia = (bytes: Uint8Array) => {
        const decoded = decodeLiveMedia(bytes);
        if (decoded.kind !== 'ok') return;
        if (drawing) {
            // Only the newest waiting frame is worth drawing; the one it replaces is acknowledged unseen.
            if (queued !== null) ack(queued.media.seq, queued.generation);
            queued = { media: decoded.media, generation };
            return;
        }
        paint(decoded.media, generation);
    };

    const receive = (data: string | Uint8Array) => {
        if (typeof data !== 'string') {
            receiveMedia(data);
            return;
        }
        const message = readLiveEngineMessage(data);
        if (message === null) return;
        switch (message.type) {
            case 'hello':
            case 'input-refused':
                return;
            case 'state':
                set({ mode: message.mode, agent: message.agent, others: message.others, viewport: message.viewport });
                return;
            case 'navigated':
                set({ origin: message.origin, blocked: null });
                return;
            case 'blocked':
                drawer?.clear();
                set({
                    blocked: { reason: message.reason, origin: message.origin },
                    origin: message.origin,
                    hasFrame: false,
                });
                return;
            case 'end':
                finish(message.reason);
                return;
        }
    };

    const retryLater = () => {
        // No local deadline: the engine ends the session at `endsAt` and says so on the next read.
        if (disposed || view.endReason !== null) return;
        const delay = RECONNECT_DELAYS_MS[Math.min(attempts, RECONNECT_DELAYS_MS.length - 1)] ?? 1_000;
        attempts += 1;
        cancelRetry = schedule(() => {
            cancelRetry = null;
            connect();
        }, delay);
    };

    const update = (session: ReadBrowserSession) => {
        if (session.id !== opened.id || view.endReason !== null) return;
        set({ session, mode: session.mode });
        if (session.status !== 'open') finish(session.endReason ?? 'unknown');
    };

    // The channel says nothing about why it dropped or was refused; the session's own state does.
    const lost = () => {
        if (disposed || view.endReason !== null) return;
        set({ connection: 'reconnecting', hasFrame: false });
        deps.engineApi.browser.getSession(opened.id, AbortSignal.timeout(API_TIMEOUT_MS)).then(
            (result) => {
                if (disposed || view.endReason !== null) return;
                if (result.kind === 'ok') {
                    update(result.data);
                } else if (result.problem.status === 404 || result.problem.status === 401) {
                    finish(result.problem.status === 401 ? 'revoked' : 'unknown');
                }
                retryLater();
            },
            () => {
                retryLater();
            },
        );
    };

    function connect() {
        if (disposed || view.endReason !== null) return;
        generation += 1;
        const current = generation;
        drawing = false;
        connection = deps.openChannel(opened.id, {
            onOpen: () => {
                if (current !== generation) return;
                attempts = 0;
                set({ connection: 'open' });
                send({ type: 'hello', versions: [...LIVE_CHANNEL_VERSIONS] });
                sendView();
            },
            onMessage: (data) => {
                if (current === generation) receive(data);
            },
            onClose: () => {
                if (current !== generation) return;
                connection = null;
                lost();
            },
        });
    }

    if (view.endReason === null) connect();

    return {
        id: opened.id,
        tabId: opened.tabId,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getView: () => view,
        attach: (target, initialSize) => {
            drawer = target;
            size = initialSize;
            sendView();
            return () => {
                if (drawer !== target) return;
                drawer = null;
                sendView();
            };
        },
        resize: (next) => {
            if (clampSize(next.width) === clampSize(size.width) && clampSize(next.height) === clampSize(size.height))
                return;
            size = next;
            sendView();
        },
        setPageVisible: (visible) => {
            if (visible === pageVisible) return;
            pageVisible = visible;
            sendView();
        },
        input: (event, essential) => {
            if (view.mode !== 'controlling' || view.blocked !== null || view.connection !== 'open') return false;
            if (view.endReason !== null || !budget(essential)) return false;
            send({ type: 'input', event });
            return true;
        },
        update,
        end: async () => {
            if (view.endReason !== null) return;
            try {
                const result = await deps.engineApi.browser.end(opened.id, AbortSignal.timeout(API_TIMEOUT_MS));
                if (result.kind === 'ok') update(result.data);
            } catch {
                // The engine ends it at `endsAt` or, for a controller, after the idle limit; the channel closes now.
            }
            finish('ended');
        },
        dispose: () => {
            disposed = true;
            cancelRetry?.();
            cancelRetry = null;
            closeChannel();
        },
    };
}
