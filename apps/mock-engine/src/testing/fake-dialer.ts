import type { Bytes } from '@ptbk/protocol';

import type {
    DialFailure,
    DialResult,
    RelayConnection,
    RelayConnectionHandlers,
    RelayDialer,
} from '../domain/tunnel/relay-dialer';
import type { RelayTarget } from '../domain/tunnel/relay-target';

/** The engine's side of a fake WebSocket: records what the engine sent, and lets a test play the relay. */
export interface FakeConnection extends RelayConnection {
    readonly texts: string[];
    readonly binaries: Bytes[];
    /** Every `close` call, in order (the real socket ignores all but the first). */
    readonly closeCodes: number[];
    /** The relay sends a text message. */
    relayText(text: string): void;
    relayJson(message: unknown): void;
    relayBinary(bytes: Uint8Array): void;
    /** The socket closes with `code` (the relay's close, or 1006 for a lost connection). */
    relayClose(code: number): void;
}

export interface PendingDial {
    readonly target: RelayTarget;
    readonly signal: AbortSignal;
    open(): FakeConnection;
    fail(failure: DialFailure): void;
    reject(error: Error): void;
}

export interface FakeDialer extends RelayDialer {
    readonly dials: readonly PendingDial[];
    last(): PendingDial;
}

function createFakeConnection(handlers: RelayConnectionHandlers): FakeConnection {
    let closed = false;
    const texts: string[] = [];
    const binaries: Bytes[] = [];
    const closeCodes: number[] = [];
    return {
        texts,
        binaries,
        closeCodes,
        sendText: (text) => texts.push(text),
        sendBinary: (bytes) => binaries.push(bytes),
        close: (code) => closeCodes.push(code),
        relayText: (text) => {
            handlers.onText(text);
        },
        relayJson: (message) => {
            handlers.onText(JSON.stringify(message));
        },
        relayBinary: (bytes) => {
            handlers.onBinary(new Uint8Array(bytes));
        },
        relayClose: (code) => {
            if (closed) return;
            closed = true;
            handlers.onClose(code);
        },
    };
}

export function createFakeDialer(): FakeDialer {
    const dials: PendingDial[] = [];
    return {
        dials,
        last() {
            const dial = dials.at(-1);
            if (dial === undefined) throw new Error('no dial yet');
            return dial;
        },
        dial(target, handlers, signal) {
            return new Promise<DialResult>((resolve, reject) => {
                dials.push({
                    target,
                    signal,
                    open() {
                        const connection = createFakeConnection(handlers);
                        resolve({ kind: 'open', connection });
                        return connection;
                    },
                    fail(failure) {
                        resolve({ kind: 'failed', failure });
                    },
                    reject,
                });
            });
        },
    };
}

/** Lets pending promise continuations and WebCrypto callbacks run; an event-loop turn, not a sleep. */
export async function flush(turns = 1): Promise<void> {
    for (let turn = 0; turn < turns; turn++) {
        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });
    }
}

/** Waits, turn by turn, until `condition` holds; fails after `maxTurns` instead of hanging. */
export async function until(condition: () => boolean, maxTurns = 1000): Promise<void> {
    for (let turn = 0; turn < maxTurns; turn++) {
        if (condition()) return;
        await flush();
    }
    throw new Error('condition not met');
}
