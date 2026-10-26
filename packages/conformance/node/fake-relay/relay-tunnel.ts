import { Duplex } from 'node:stream';

import type {
    Bytes,
    CloseCode,
    Frame,
    FrameDecode,
    StreamId,
    TunnelAuth,
    TunnelChallenge,
    TunnelReady,
} from '@ptbk/protocol';
import {
    CLOSE_CODE,
    FrameType,
    INITIAL_WINDOW_BYTES,
    MAX_FRAME_PAYLOAD_BYTES,
    MAX_WINDOW_INCREMENT,
    createSendWindow,
    decodeFrame,
    encodeFrame,
} from '@ptbk/protocol';

import type { ConnectionClosed, ConnectionEvent, RelayConnection } from './fake-relay';

/** One binary message from the engine, without its payload (kept for the whole run). */
export interface EngineFrame {
    readonly at: number;
    /** Bytes of the whole binary message. */
    readonly size: number;
    readonly kind: FrameDecode['kind'];
    /** The decoded type, for a valid frame. */
    readonly type: number | null;
}

export interface DataRecord {
    readonly at: number;
    readonly bytes: number;
}

export interface StreamAddress {
    readonly family: 4 | 6;
    readonly address: Bytes;
    readonly port: number;
}

export interface OpenStreamOptions {
    /** The browser address in `OPEN`; a random TEST-NET-3 address by default, so per-IP rate limits never bite. */
    readonly address?: StreamAddress;
    /**
     * `true` (default) grants the engine credit back for every DATA frame as it arrives; `false` grants nothing until
     * `grant` is called, to see whether the engine stops at its credit.
     */
    readonly autoGrant?: boolean;
}

function randomTestNetAddress(): StreamAddress {
    const [last = 1, high = 0, low = 0] = crypto.getRandomValues(new Uint8Array(3));
    return { family: 4, address: Uint8Array.of(203, 0, 113, last), port: 1024 + (((high << 8) | low) % 60_000) };
}

/**
 * The relay's end of one stream, as a Node `Duplex`: what is written goes out as DATA within the credit the engine
 * granted, and the engine's DATA comes out to the reader. A TLS client can run on top of it (`tls.connect({ socket })`)
 * to talk to the engine's TLS server through the tunnel, exactly as a browser's bytes would.
 */
export class RelayStream extends Duplex {
    readonly id: StreamId;
    readonly openedAt = performance.now();
    /** Every DATA frame the engine sent on this stream, also after it closed. */
    readonly dataLog: DataRecord[] = [];
    /** DATA bytes beyond the credit this side granted; anything above 0 is a flow-control violation. */
    overrunBytes = 0;
    /** Total credit given to the engine: `INITIAL_WINDOW_BYTES` plus every `WINDOW` sent. */
    grantedBytes = INITIAL_WINDOW_BYTES;
    receivedBytes = 0;
    /** The `CLOSE` code the engine sent, if it did. */
    engineCloseCode: CloseCode | null = null;
    readonly engineClosed: Promise<CloseCode>;
    readonly #tunnel: RelayTunnel;
    readonly #autoGrant: boolean;
    readonly #sendWindow = createSendWindow(INITIAL_WINDOW_BYTES);
    readonly #pending: { chunk: Buffer; callback: (error?: Error | null) => void }[] = [];
    #open = true;
    #resolveEngineClosed: (code: CloseCode) => void = () => undefined;

    constructor(tunnel: RelayTunnel, id: StreamId, autoGrant: boolean) {
        // Half-open, so a TLS client whose read side ended can still flush its close_notify; once the stream is
        // closed, writes are dropped rather than failed.
        super({ allowHalfOpen: true });
        this.#tunnel = tunnel;
        this.id = id;
        this.#autoGrant = autoGrant;
        this.engineClosed = new Promise((resolve) => {
            this.#resolveEngineClosed = resolve;
        });
    }

    isOpen(): boolean {
        return this.#open;
    }

    /** Credit the engine has granted this side and not yet used. */
    sendCredit(): number {
        return this.#sendWindow.available();
    }

    /** Sends `WINDOW` for `bytes` more, split into increments the codec accepts. */
    grant(bytes: number): void {
        let rest = bytes;
        while (rest > 0) {
            const increment = Math.min(rest, MAX_WINDOW_INCREMENT);
            this.#tunnel.sendFrame({ type: FrameType.WINDOW, streamId: this.id, increment });
            this.grantedBytes += increment;
            rest -= increment;
        }
    }

    /** Closes from the relay's side with `CLOSE`; the engine must not send on the stream afterwards. */
    closeFromRelay(code: CloseCode = CLOSE_CODE.NORMAL): void {
        if (!this.#open) return;
        this.#open = false;
        this.#tunnel.sendFrame({ type: FrameType.CLOSE, streamId: this.id, code });
        this.#abandonWrites();
        this.push(null);
    }

    onData(payload: Bytes): void {
        this.dataLog.push({ at: performance.now(), bytes: payload.length });
        this.receivedBytes += payload.length;
        if (this.receivedBytes > this.grantedBytes) {
            this.overrunBytes = this.receivedBytes - this.grantedBytes;
        }
        if (!this.#open) return;
        this.push(Buffer.from(payload));
        if (this.#autoGrant) this.grant(payload.length);
    }

    onWindow(increment: number): boolean {
        if (this.#sendWindow.grant(increment).kind === 'violation') return false;
        this.#pump();
        return true;
    }

    onClose(code: CloseCode): void {
        if (this.engineCloseCode === null) {
            this.engineCloseCode = code;
            this.#resolveEngineClosed(code);
        }
        if (!this.#open) return;
        this.#open = false;
        this.#abandonWrites();
        this.push(null);
    }

    /** The tunnel is gone; nothing more will arrive. */
    onTunnelLost(): void {
        if (!this.#open) return;
        this.#open = false;
        this.#abandonWrites();
        this.push(null);
    }

    override _read(): void {
        // Data is pushed as it arrives; credit is granted per frame (or by the check), not by reads.
    }

    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        if (!this.#open) {
            callback();
            return;
        }
        this.#pending.push({ chunk, callback });
        this.#pump();
    }

    override _final(callback: (error?: Error | null) => void): void {
        if (this.#open) {
            this.#open = false;
            this.#tunnel.sendFrame({ type: FrameType.CLOSE, streamId: this.id, code: CLOSE_CODE.NORMAL });
        }
        callback();
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        if (this.#open) {
            this.#open = false;
            const code = error === null ? CLOSE_CODE.NORMAL : CLOSE_CODE.RESET;
            this.#tunnel.sendFrame({ type: FrameType.CLOSE, streamId: this.id, code });
        }
        this.#abandonWrites();
        callback(error);
    }

    #pump(): void {
        while (this.#open) {
            const head = this.#pending[0];
            if (head === undefined) return;
            const size = Math.min(head.chunk.length, MAX_FRAME_PAYLOAD_BYTES, this.#sendWindow.available());
            if (size === 0) return;
            this.#sendWindow.consume(size);
            this.#tunnel.sendFrame({
                type: FrameType.DATA,
                streamId: this.id,
                payload: new Uint8Array(head.chunk.subarray(0, size)),
            });
            if (size === head.chunk.length) {
                this.#pending.shift();
                head.callback();
            } else {
                head.chunk = head.chunk.subarray(size);
            }
        }
    }

    #abandonWrites(): void {
        for (const { callback } of this.#pending.splice(0)) callback();
    }
}

export interface RelayTunnelDetails {
    readonly challenge: TunnelChallenge;
    readonly auth: TunnelAuth;
    readonly ready: TunnelReady;
}

/**
 * A tunnel after `ready`, seen from the relay. Records every frame the engine sends and every rule it breaks on the
 * way (`problems`), so checks can judge the engine's framing as well as the outcome they drive.
 */
export class RelayTunnel {
    readonly connection: RelayConnection;
    readonly challenge: TunnelChallenge;
    readonly auth: TunnelAuth;
    readonly ready: TunnelReady;
    readonly readyAt = performance.now();
    readonly frames: EngineFrame[] = [];
    /** Rules of C-02 the engine broke on this tunnel, in plain words, without any payload. */
    readonly problems: string[] = [];
    readonly #streams = new Map<number, RelayStream>();
    #nextStreamId = 1;

    constructor(connection: RelayConnection, details: RelayTunnelDetails) {
        this.connection = connection;
        this.challenge = details.challenge;
        this.auth = details.auth;
        this.ready = details.ready;
        connection.takeOver((event) => {
            this.#onEvent(event);
        });
    }

    get closed(): Promise<ConnectionClosed> {
        return this.connection.closed;
    }

    isOpen(): boolean {
        return this.connection.isOpen();
    }

    /** Opens the next stream ID with `OPEN`. */
    openStream(options: OpenStreamOptions = {}): RelayStream {
        const id = this.#nextStreamId++ as StreamId;
        const stream = new RelayStream(this, id, options.autoGrant ?? true);
        this.#streams.set(id, stream);
        const { family, address, port } = options.address ?? randomTestNetAddress();
        this.sendFrame({ type: FrameType.OPEN, streamId: id, family, address, port });
        return stream;
    }

    /** Reserves stream IDs below `next` as used, for checks that send raw frames. */
    skipStreamIds(next: number): void {
        this.#nextStreamId = Math.max(this.#nextStreamId, next);
    }

    get nextStreamId(): number {
        return this.#nextStreamId;
    }

    sendFrame(frame: Frame): void {
        this.connection.sendBinary(encodeFrame(frame));
    }

    sendRaw(bytes: Uint8Array): void {
        this.connection.sendBinary(bytes);
    }

    close(code: number): void {
        this.connection.close(code);
    }

    terminate(): void {
        this.connection.terminate();
    }

    #onEvent(event: ConnectionEvent): void {
        switch (event.kind) {
            case 'text':
                this.problems.push('sent a text message after ready');
                return;
            case 'closed':
                for (const stream of this.#streams.values()) stream.onTunnelLost();
                return;
            case 'binary':
                this.#onFrame(event.bytes, event.at);
                return;
        }
    }

    #onFrame(bytes: Bytes, at: number): void {
        const decoded = decodeFrame(bytes);
        this.frames.push({
            at,
            size: bytes.length,
            kind: decoded.kind,
            type: decoded.kind === 'frame' ? decoded.frame.type : null,
        });
        switch (decoded.kind) {
            case 'invalid':
                this.problems.push(`sent an invalid frame (${decoded.reason}, ${String(bytes.length)} bytes)`);
                return;
            case 'ignored':
                this.problems.push(`sent an ignorable frame of type ${String(decoded.typeCode)}, which v1 never sends`);
                return;
            case 'frame':
                this.#onValidFrame(decoded.frame);
                return;
        }
    }

    #onValidFrame(frame: Frame): void {
        if (frame.type === FrameType.OPEN) {
            this.problems.push('opened a stream; only the relay opens streams');
            return;
        }
        const stream = this.#streams.get(frame.streamId);
        if (stream === undefined) {
            this.problems.push(`sent a frame for stream ${String(frame.streamId)}, which was never opened`);
            return;
        }
        switch (frame.type) {
            case FrameType.DATA:
                stream.onData(frame.payload);
                return;
            case FrameType.WINDOW:
                if (!stream.onWindow(frame.increment)) {
                    this.problems.push(`granted credit past MAX_WINDOW_BYTES on stream ${String(frame.streamId)}`);
                }
                return;
            case FrameType.CLOSE:
                stream.onClose(frame.code);
                return;
        }
    }
}
