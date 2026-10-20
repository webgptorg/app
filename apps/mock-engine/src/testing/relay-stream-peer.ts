import type { AddressFamily, Bytes, CloseCode, FlowWindow, StreamId } from '@ptbk/protocol';
import {
    CLOSE_CODE,
    FrameType,
    INITIAL_WINDOW_BYTES,
    MAX_FRAME_PAYLOAD_BYTES,
    concatBytes,
    createReceiveWindow,
    createSendWindow,
    decodeFrame,
    encodeFrame,
} from '@ptbk/protocol';

export interface PeerRemote {
    readonly family: AddressFamily;
    readonly address: Bytes;
    readonly port: number;
}

export interface RelayStreamPeerOptions {
    /** Delivers one encoded frame to the engine. */
    send(bytes: Bytes): void;
    /** Grant `WINDOW` credit back as soon as bytes arrive (default `true`). */
    readonly autoGrant?: boolean;
}

/** The relay's end of one stream. */
export interface PeerStream {
    readonly id: StreamId;
    /** Sends `bytes` as DATA frames within the engine's credit; resolves once all are sent. */
    write(bytes: Uint8Array): Promise<void>;
    received(): Bytes;
    receivedLength(): number;
    waitForBytes(length: number): Promise<void>;
    /** Credit the relay may still send on this stream. */
    sendCredit(): number;
    /** Sends a `WINDOW` frame by hand. */
    grant(increment: number): void;
    close(code?: CloseCode): void;
    /** The code of the engine's `CLOSE`, if it sent one. */
    closedWith(): CloseCode | undefined;
    waitForClose(): Promise<CloseCode>;
}

export interface RelayStreamPeer {
    /** Takes one encoded frame from the engine. */
    receive(bytes: Uint8Array): void;
    open(remote?: PeerRemote): PeerStream;
    /** Sends arbitrary bytes, for crafting frames the engine must refuse. */
    sendRaw(bytes: Uint8Array): void;
    /** Frames from the engine that the relay would treat as protocol errors. */
    errors(): readonly string[];
}

interface PeerState {
    readonly stream: PeerStream;
    readonly sendWindow: FlowWindow;
    readonly receiveWindow: FlowWindow;
    readonly chunks: Bytes[];
    receivedBytes: number;
    closeCode: CloseCode | undefined;
    readonly wakers: Set<() => void>;
}

const DEFAULT_REMOTE: PeerRemote = { family: 4, address: Uint8Array.of(203, 0, 113, 7), port: 51_234 };

/** The relay side of a tunnel's streams over raw frame bytes, transport-agnostic, built only from `@ptbk/protocol`. */
export function createRelayStreamPeer(options: RelayStreamPeerOptions): RelayStreamPeer {
    const autoGrant = options.autoGrant ?? true;
    const streams = new Map<StreamId, PeerState>();
    const errors: string[] = [];
    let nextId = 1;

    function wake(state: PeerState): void {
        for (const waker of [...state.wakers]) waker();
    }

    function waitFor(state: PeerState, done: () => boolean): Promise<void> {
        if (done()) return Promise.resolve();
        return new Promise((resolve) => {
            const waker = (): void => {
                if (!done()) return;
                state.wakers.delete(waker);
                resolve();
            };
            state.wakers.add(waker);
        });
    }

    function createState(id: StreamId): PeerState {
        const sendWindow = createSendWindow(INITIAL_WINDOW_BYTES);
        const receiveWindow = createReceiveWindow(INITIAL_WINDOW_BYTES);
        const chunks: Bytes[] = [];
        const state: PeerState = {
            sendWindow,
            receiveWindow,
            chunks,
            receivedBytes: 0,
            closeCode: undefined,
            wakers: new Set(),
            stream: {
                id,
                async write(bytes) {
                    let offset = 0;
                    while (offset < bytes.length) {
                        await waitFor(state, () => state.closeCode !== undefined || sendWindow.available() > 0);
                        if (state.closeCode !== undefined) throw new Error('stream closed by the engine');
                        const size = Math.min(sendWindow.available(), MAX_FRAME_PAYLOAD_BYTES, bytes.length - offset);
                        sendWindow.consume(size);
                        const payload = new Uint8Array(bytes.subarray(offset, offset + size));
                        options.send(encodeFrame({ type: FrameType.DATA, streamId: id, payload }));
                        offset += size;
                    }
                },
                received: () => concatBytes(...chunks),
                receivedLength: () => state.receivedBytes,
                waitForBytes: (length) => waitFor(state, () => state.receivedBytes >= length),
                sendCredit: () => sendWindow.available(),
                grant(increment) {
                    receiveWindow.grant(increment);
                    options.send(encodeFrame({ type: FrameType.WINDOW, streamId: id, increment }));
                },
                close(code = CLOSE_CODE.NORMAL) {
                    streams.delete(id);
                    options.send(encodeFrame({ type: FrameType.CLOSE, streamId: id, code }));
                },
                closedWith: () => state.closeCode,
                async waitForClose() {
                    await waitFor(state, () => state.closeCode !== undefined);
                    return state.closeCode ?? CLOSE_CODE.NORMAL;
                },
            },
        };
        return state;
    }

    return {
        receive(bytes) {
            const decoded = decodeFrame(bytes);
            if (decoded.kind !== 'frame') {
                errors.push(decoded.kind === 'invalid' ? decoded.reason : 'ignored');
                return;
            }
            const frame = decoded.frame;
            const state = streams.get(frame.streamId);
            if (state === undefined) {
                errors.push(`frame ${String(frame.type)} for unknown stream ${String(frame.streamId)}`);
                return;
            }
            switch (frame.type) {
                case FrameType.OPEN:
                    errors.push('engine sent OPEN');
                    return;
                case FrameType.DATA:
                    if (state.receiveWindow.consume(frame.payload.length).kind === 'violation') {
                        errors.push('engine sent DATA beyond credit');
                        return;
                    }
                    state.chunks.push(frame.payload);
                    state.receivedBytes += frame.payload.length;
                    if (autoGrant) state.stream.grant(frame.payload.length);
                    break;
                case FrameType.WINDOW:
                    if (state.sendWindow.grant(frame.increment).kind === 'violation') {
                        errors.push('engine over-granted');
                    }
                    break;
                case FrameType.CLOSE:
                    state.closeCode = frame.code;
                    streams.delete(frame.streamId);
                    break;
            }
            wake(state);
        },
        open(remote = DEFAULT_REMOTE) {
            const id = nextId++ as StreamId;
            const state = createState(id);
            streams.set(id, state);
            options.send(encodeFrame({ type: FrameType.OPEN, streamId: id, ...remote }));
            return state.stream;
        },
        sendRaw(bytes) {
            options.send(new Uint8Array(bytes));
        },
        errors: () => errors,
    };
}
