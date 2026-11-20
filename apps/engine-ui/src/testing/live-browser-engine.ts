import { KNOWN_CAPABILITIES, LiveClientMessage } from '@ptbk/engine-api';
import { createInMemoryEngine, DEFAULT_CAPABILITIES } from '@ptbk/engine-api/in-memory';
import type { InMemoryEngine, InMemoryEngineApiOptions } from '@ptbk/engine-api/in-memory';

import type { OpenLiveChannel } from '../features/browser/live-channel';
import type { FrameDrawer } from '../features/browser/live-session';
import { TEST_NOW } from './test-engine-api';

export interface LiveBrowserTestEngine extends InMemoryEngine {
    readonly openLiveChannel: OpenLiveChannel;
    /** What the browser sent over every channel, parsed, oldest first. */
    readonly sent: LiveClientMessage[];
    /** Channels opened so far, refused ones included. */
    readonly channels: () => number;
    /** Drops the newest channel as a network would, leaving the session open on the engine. */
    readonly drop: () => void;
}

/**
 * The in-memory engine with `browser-tab@1` and its channel bound the way the engine's gateway would bind a WebSocket.
 * Messages cross on microtasks, as they would arrive from a socket, so nothing re-enters the sender.
 */
export function createLiveBrowserTestEngine(options: InMemoryEngineApiOptions = {}): LiveBrowserTestEngine {
    const engine = createInMemoryEngine({
        clock: { now: () => TEST_NOW },
        seed: {
            engine: { name: 'Test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
            agents: [{ id: 'ada', source: 'Ada\nPERSONA Research' }],
        },
        capabilities: [...DEFAULT_CAPABILITIES, KNOWN_CAPABILITIES.browserTab],
        ...options,
    });
    const sent: LiveClientMessage[] = [];
    const drops: (() => void)[] = [];
    let opened = 0;
    const openLiveChannel: OpenLiveChannel = (sessionId, handlers) => {
        opened += 1;
        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            queueMicrotask(handlers.onClose);
        };
        const attached = engine.attachLiveChannel(sessionId, {
            send: (data) => {
                if (!closed)
                    queueMicrotask(() => {
                        handlers.onMessage(data);
                    });
            },
            close,
        });
        if (attached.kind === 'refused') {
            close();
            return { send: () => undefined, close: () => undefined };
        }
        const { peer } = attached;
        queueMicrotask(handlers.onOpen);
        const hangUp = () => {
            if (closed) return;
            peer.closed();
            close();
        };
        drops.push(hangUp);
        return {
            send: (text) => {
                if (closed) return;
                sent.push(LiveClientMessage.parse(JSON.parse(text)));
                peer.receive(text);
            },
            close: hangUp,
        };
    };
    return {
        ...engine,
        openLiveChannel,
        sent,
        channels: () => opened,
        drop: () => drops.at(-1)?.(),
    };
}

/** Lets queued channel messages, and the engine calls they start, settle: each macrotask drains every microtask. */
export async function flushLive(rounds = 2): Promise<void> {
    for (let round = 0; round < rounds; round++) {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
    }
}

export interface ManualDrawer extends FrameDrawer {
    /** Sequence numbers of the frames drawn so far, oldest first. */
    readonly drawn: number[];
    /** Draws waiting for `release()`. */
    readonly waiting: () => number;
    readonly cleared: () => number;
    /** Finishes every waiting draw; the session acknowledges each, and the engine sends the next frame. */
    readonly release: () => void;
}

/**
 * Draws only when the test says so: the in-memory engine answers every acknowledgement with the next frame, so a
 * drawer that finished at once would stream frames for as long as the test runs.
 */
export function createManualDrawer(): ManualDrawer {
    const drawn: number[] = [];
    let waiting: (() => void)[] = [];
    let cleared = 0;
    return {
        drawn,
        waiting: () => waiting.length,
        cleared: () => cleared,
        draw: (media) =>
            new Promise((resolve) => {
                waiting.push(() => {
                    drawn.push(media.seq);
                    resolve();
                });
            }),
        clear: () => {
            cleared += 1;
        },
        release: () => {
            const now = waiting;
            waiting = [];
            for (const finish of now) finish();
        },
    };
}
