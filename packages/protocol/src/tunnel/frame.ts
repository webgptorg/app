import { z } from 'zod';

import type { Bytes } from '../bytes';
import { MAX_FRAME_PAYLOAD_BYTES } from './constants';

/**
 * Frame-type registry (ADR 0010 §4). Codes live in bits 0–6 of the type byte: 0 is never valid, 1–4 are v1, 5–127 are
 * reserved for a new protocol version or a negotiated feature. Bit 7 is `FRAME_IGNORABLE_FLAG`.
 */
export const FrameType = Object.freeze({ OPEN: 1, DATA: 2, CLOSE: 3, WINDOW: 4 } as const);
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

/** On an unknown code, the receiver drops the frame instead of failing the tunnel. Never set on v1 types. */
export const FRAME_IGNORABLE_FLAG = 0x80;
/** `[u8 type][u32 streamId, big-endian]`; the payload is the rest of the WebSocket message. */
export const FRAME_HEADER_BYTES = 5;
export const MAX_WINDOW_INCREMENT = 0x7fff_ffff;

/** Reason for closing one stream, carried in a `CLOSE` frame. */
export const CLOSE_CODE = Object.freeze({ NORMAL: 0, RESET: 1, REFUSED: 2, TIMEOUT: 3, FLOW_CONTROL: 4 } as const);
export type CloseCode = (typeof CLOSE_CODE)[keyof typeof CLOSE_CODE];

/** u32, non-zero. Only the relay opens streams; IDs increase per tunnel and are never reused. */
export const StreamId = z.int().min(1).max(0xffff_ffff).brand<'StreamId'>();
export type StreamId = z.infer<typeof StreamId>;

const TYPE_CODE_MASK = 0x7f;
const IPV4_BYTES = 4;
const IPV6_BYTES = 16;
const CLOSE_CODES: ReadonlySet<number> = new Set(Object.values(CLOSE_CODE));

export type AddressFamily = 4 | 6;

/** The browser's address as the relay saw it, so the engine can rate-limit and audit. */
export interface OpenFrame {
    readonly type: typeof FrameType.OPEN;
    readonly streamId: StreamId;
    readonly family: AddressFamily;
    /** 4 bytes for IPv4, 16 for IPv6. */
    readonly address: Bytes;
    readonly port: number;
}

export interface DataFrame {
    readonly type: typeof FrameType.DATA;
    readonly streamId: StreamId;
    /** 1..`MAX_FRAME_PAYLOAD_BYTES` bytes. */
    readonly payload: Bytes;
}

export interface CloseFrame {
    readonly type: typeof FrameType.CLOSE;
    readonly streamId: StreamId;
    readonly code: CloseCode;
}

export interface WindowFrame {
    readonly type: typeof FrameType.WINDOW;
    readonly streamId: StreamId;
    /** Bytes of credit added, 1..`MAX_WINDOW_INCREMENT`. */
    readonly increment: number;
}

export type Frame = OpenFrame | DataFrame | CloseFrame | WindowFrame;

export type FrameInvalidReason =
    | 'too-short'
    | 'unknown-type'
    | 'bad-flags'
    | 'stream-id-zero'
    | 'payload-too-large'
    | 'empty-data'
    | 'bad-open-payload'
    | 'bad-close-code'
    | 'bad-window-increment'
    | 'trailing-bytes';

export type FrameDecode =
    | { readonly kind: 'frame'; readonly frame: Frame }
    /** An unknown code with the ignorable flag; `typeCode` is the code without the flag. Drop it. */
    | { readonly kind: 'ignored'; readonly typeCode: number }
    | { readonly kind: 'invalid'; readonly reason: FrameInvalidReason };

function addressBytes(family: AddressFamily): number {
    return family === 4 ? IPV4_BYTES : IPV6_BYTES;
}

function header(type: FrameType, streamId: StreamId, payloadBytes: number): { bytes: Bytes; view: DataView } {
    if (!Number.isInteger(streamId) || streamId < 1 || streamId > 0xffff_ffff) {
        throw new RangeError('streamId must be a non-zero u32');
    }
    const bytes = new Uint8Array(FRAME_HEADER_BYTES + payloadBytes);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, type);
    view.setUint32(1, streamId);
    return { bytes, view };
}

/**
 * One frame as one binary WebSocket message. Throws a RangeError for a frame the decoder would refuse (stream ID 0,
 * empty or oversized DATA, a bad address, port, close code or increment): those are bugs in the sender.
 */
export function encodeFrame(frame: Frame): Bytes {
    switch (frame.type) {
        case FrameType.OPEN: {
            if (frame.address.length !== addressBytes(frame.family)) {
                throw new RangeError('OPEN address length does not match its family');
            }
            if (!Number.isInteger(frame.port) || frame.port < 0 || frame.port > 0xffff) {
                throw new RangeError('OPEN port must be a u16');
            }
            const { bytes, view } = header(frame.type, frame.streamId, 1 + frame.address.length + 2);
            view.setUint8(FRAME_HEADER_BYTES, frame.family);
            bytes.set(frame.address, FRAME_HEADER_BYTES + 1);
            view.setUint16(FRAME_HEADER_BYTES + 1 + frame.address.length, frame.port);
            return bytes;
        }
        case FrameType.DATA: {
            if (frame.payload.length < 1 || frame.payload.length > MAX_FRAME_PAYLOAD_BYTES) {
                throw new RangeError('DATA payload must be 1..MAX_FRAME_PAYLOAD_BYTES bytes');
            }
            const { bytes } = header(frame.type, frame.streamId, frame.payload.length);
            bytes.set(frame.payload, FRAME_HEADER_BYTES);
            return bytes;
        }
        case FrameType.CLOSE: {
            if (!CLOSE_CODES.has(frame.code)) throw new RangeError('unknown CLOSE code');
            const { bytes, view } = header(frame.type, frame.streamId, 1);
            view.setUint8(FRAME_HEADER_BYTES, frame.code);
            return bytes;
        }
        case FrameType.WINDOW: {
            if (!Number.isInteger(frame.increment) || frame.increment < 1 || frame.increment > MAX_WINDOW_INCREMENT) {
                throw new RangeError('WINDOW increment must be 1..MAX_WINDOW_INCREMENT');
            }
            const { bytes, view } = header(frame.type, frame.streamId, 4);
            view.setUint32(FRAME_HEADER_BYTES, frame.increment);
            return bytes;
        }
    }
}

function invalid(reason: FrameInvalidReason): FrameDecode {
    return { kind: 'invalid', reason };
}

function isFrameType(code: number): code is FrameType {
    return code >= FrameType.OPEN && code <= FrameType.WINDOW;
}

function decodeOpen(streamId: StreamId, payload: Uint8Array, view: DataView): FrameDecode {
    const family = payload[0];
    if (family !== 4 && family !== 6) return invalid('bad-open-payload');
    const length = addressBytes(family);
    if (payload.length !== 1 + length + 2) return invalid('bad-open-payload');
    return {
        kind: 'frame',
        frame: {
            type: FrameType.OPEN,
            streamId,
            family,
            address: payload.slice(1, 1 + length),
            port: view.getUint16(1 + length),
        },
    };
}

function decodeFixed(payload: Uint8Array, length: number): FrameInvalidReason | undefined {
    if (payload.length < length) return 'too-short';
    if (payload.length > length) return 'trailing-bytes';
    return undefined;
}

/**
 * Decodes one binary WebSocket message. Total over untrusted bytes: never throws, never reads past `bytes`, and copies
 * at most one payload. Checks run in a fixed order: header length, payload size, type byte, stream ID, then the
 * type's payload rules.
 */
export function decodeFrame(bytes: Uint8Array): FrameDecode {
    if (bytes.length < FRAME_HEADER_BYTES) return invalid('too-short');
    if (bytes.length - FRAME_HEADER_BYTES > MAX_FRAME_PAYLOAD_BYTES) return invalid('payload-too-large');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const typeByte = view.getUint8(0);
    const code = typeByte & TYPE_CODE_MASK;
    const ignorable = (typeByte & FRAME_IGNORABLE_FLAG) !== 0;
    if (code === 0) return invalid('unknown-type');
    if (!isFrameType(code)) return ignorable ? { kind: 'ignored', typeCode: code } : invalid('unknown-type');
    if (ignorable) return invalid('bad-flags');
    const rawStreamId = view.getUint32(1);
    if (rawStreamId === 0) return invalid('stream-id-zero');
    const streamId = rawStreamId as StreamId;
    const payload = bytes.subarray(FRAME_HEADER_BYTES);
    const payloadView = new DataView(bytes.buffer, bytes.byteOffset + FRAME_HEADER_BYTES, payload.length);
    switch (code) {
        case FrameType.OPEN:
            return decodeOpen(streamId, payload, payloadView);
        case FrameType.DATA:
            if (payload.length === 0) return invalid('empty-data');
            return { kind: 'frame', frame: { type: FrameType.DATA, streamId, payload: payload.slice() } };
        case FrameType.CLOSE: {
            const malformed = decodeFixed(payload, 1);
            if (malformed !== undefined) return invalid(malformed);
            const closeCode = payloadView.getUint8(0);
            if (!CLOSE_CODES.has(closeCode)) return invalid('bad-close-code');
            return { kind: 'frame', frame: { type: FrameType.CLOSE, streamId, code: closeCode as CloseCode } };
        }
        case FrameType.WINDOW: {
            const malformed = decodeFixed(payload, 4);
            if (malformed !== undefined) return invalid(malformed);
            const increment = payloadView.getUint32(0);
            if (increment < 1 || increment > MAX_WINDOW_INCREMENT) return invalid('bad-window-increment');
            return { kind: 'frame', frame: { type: FrameType.WINDOW, streamId, increment } };
        }
    }
}
