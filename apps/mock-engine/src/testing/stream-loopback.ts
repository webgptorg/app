import type { Frame } from '@ptbk/protocol';
import { encodeFrame } from '@ptbk/protocol';

import type { MuxProtocolError, StreamMux } from '../domain/tunnel/stream-mux';
import { createStreamMux } from '../domain/tunnel/stream-mux';
import type { StreamEvents, TunnelStream } from '../domain/tunnel/tunnel-stream';
import type { RelayStreamPeer } from './relay-stream-peer';
import { createRelayStreamPeer } from './relay-stream-peer';

export interface StreamLoopback {
    readonly mux: StreamMux;
    readonly peer: RelayStreamPeer;
    /** Every frame the engine sent, in order. */
    readonly framesFromEngine: readonly Frame[];
    readonly protocolErrors: readonly MuxProtocolError[];
    /** Resolves once no frame is in flight in either direction. */
    settle(): Promise<void>;
}

function nextTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/**
 * The engine's mux and a relay peer joined by a fake asynchronous transport: each frame is delivered in its own
 * `setImmediate` turn, in order, like WebSocket messages.
 */
export function createStreamLoopback(
    onOpen: (stream: TunnelStream) => StreamEvents,
    options: { readonly autoGrant?: boolean } = {},
): StreamLoopback {
    const framesFromEngine: Frame[] = [];
    const protocolErrors: MuxProtocolError[] = [];
    let inFlight = 0;

    function deliver(fn: () => void): void {
        inFlight++;
        setImmediate(() => {
            inFlight--;
            fn();
        });
    }

    const peer: RelayStreamPeer = createRelayStreamPeer({
        ...options,
        send: (bytes) => {
            deliver(() => {
                const result = mux.receive(bytes);
                if (result.kind === 'protocol-error') protocolErrors.push(result.reason);
            });
        },
    });
    const mux: StreamMux = createStreamMux({
        onOpen,
        sendFrame: (frame) => {
            framesFromEngine.push(frame);
            const bytes = encodeFrame(frame);
            deliver(() => {
                peer.receive(bytes);
            });
        },
    });

    return {
        mux,
        peer,
        framesFromEngine,
        protocolErrors,
        async settle() {
            do await nextTurn();
            while (inFlight > 0);
        },
    };
}
