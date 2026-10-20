import { describe, expect, it } from 'vitest';
import { createWebCryptoSigner, importEd25519PrivateKey } from '../ed25519';
import { deriveEngineId } from '../engine-id';
import { fromHex, toHex } from '../testing/hex';
import { signTunnelAuth, tunnelAuthInput, verifyTunnelAuth } from './auth';
import { MAX_FRAME_PAYLOAD_BYTES } from './constants';
import { FrameType, StreamId, decodeFrame, encodeFrame } from './frame';
import type { CloseCode, Frame } from './frame';
import { checkTunnelReady, negotiateTunnel, parseEngineMessage, parseRelayMessage } from './handshake';
import type { TunnelAuth, TunnelChallenge, TunnelReady } from './handshake';
import vectors from './vectors.json';

const { handshake, frames } = vectors;

function relayMessage<T extends 'challenge' | 'ready'>(text: string, type: T) {
    const parsed = parseRelayMessage(text);
    if (parsed.kind !== 'ok' || parsed.message.type !== type) throw new Error(`not a ${type}: ${text}`);
    return parsed.message as T extends 'challenge' ? TunnelChallenge : TunnelReady;
}

function authMessage(text: string): TunnelAuth {
    const parsed = parseEngineMessage(text);
    if (parsed.kind !== 'ok') throw new Error(`not an auth: ${text}`);
    return parsed.message;
}

interface VectorFrame {
    readonly type: string;
    readonly streamId: number;
    readonly family?: number;
    readonly address?: string;
    readonly port?: number;
    readonly payload?: string;
    readonly code?: number;
    readonly increment?: number;
}

function toFrame(vector: VectorFrame): Frame {
    const streamId = StreamId.parse(vector.streamId);
    switch (vector.type) {
        case 'OPEN':
            return {
                type: FrameType.OPEN,
                streamId,
                family: vector.family === 6 ? 6 : 4,
                address: fromHex(vector.address ?? ''),
                port: vector.port ?? -1,
            };
        case 'DATA':
            return { type: FrameType.DATA, streamId, payload: fromHex(vector.payload ?? '') };
        case 'CLOSE':
            return { type: FrameType.CLOSE, streamId, code: (vector.code ?? -1) as CloseCode };
        default:
            return { type: FrameType.WINDOW, streamId, increment: vector.increment ?? -1 };
    }
}

describe('golden handshake vector', () => {
    const challenge = relayMessage(handshake.challenge, 'challenge');
    const auth = authMessage(handshake.auth);
    const publicKey = fromHex(handshake.publicKey);

    it('derives the engine ID from the key', async () => {
        expect(await deriveEngineId(publicKey)).toBe(handshake.engineId);
    });

    it('builds the same signing input, with multi-element lists', () => {
        expect(challenge.protocolVersions.length).toBeGreaterThan(1);
        expect(auth.features.length).toBeGreaterThan(1);
        const input = tunnelAuthInput(challenge, auth.engineId, {
            version: auth.version,
            versions: auth.protocolVersions,
            features: auth.features,
        });
        expect(toHex(input)).toBe(handshake.signingInput);
    });

    it('signs byte-exactly with the fixed key and verifies', async () => {
        const signer = await createWebCryptoSigner(
            await importEd25519PrivateKey(fromHex(handshake.seed), { extractable: false }),
        );
        const signed = await signTunnelAuth(signer, challenge, {
            version: auth.version,
            protocolVersions: auth.protocolVersions,
            features: auth.features,
        });
        expect(JSON.stringify(signed)).toBe(handshake.auth);
        expect(verifyTunnelAuth(publicKey, challenge, auth)).toBe(true);
    });

    it.each(handshake.invalidAuth)('rejects $id', (vector) => {
        expect(vector.valid).toBe(false);
        expect(verifyTunnelAuth(publicKey, relayMessage(vector.challenge, 'challenge'), authMessage(vector.auth))).toBe(
            false,
        );
    });

    it('answers with the negotiated ready', () => {
        const ready = relayMessage(handshake.ready, 'ready');
        const negotiated = negotiateTunnel(
            { versions: challenge.protocolVersions, features: challenge.features },
            { versions: auth.protocolVersions, features: auth.features },
        );
        expect(negotiated).toEqual({ kind: 'ok', protocolVersion: ready.protocolVersion, features: ready.features });
        expect(checkTunnelReady(challenge, auth, ready)).toEqual({ kind: 'ok' });
    });

    it.each(handshake.mismatchedReady)('flags a ready with $id', (vector) => {
        expect(checkTunnelReady(challenge, auth, relayMessage(vector.ready, 'ready'))).toEqual({
            kind: vector.result,
        });
    });
});

describe('golden frame vectors', () => {
    it.each(frames.valid)('$id encodes and decodes', (vector) => {
        const frame = toFrame(vector.frame);
        expect(toHex(encodeFrame(frame))).toBe(vector.hex);
        expect(decodeFrame(fromHex(vector.hex))).toEqual({ kind: 'frame', frame });
    });

    it.each(frames.ignored)('$id is ignored', (vector) => {
        expect(decodeFrame(fromHex(vector.hex))).toEqual({ kind: 'ignored', typeCode: vector.typeCode });
    });

    it.each(frames.invalid)('$id is invalid', (vector) => {
        expect(decodeFrame(fromHex(vector.hex))).toEqual({ kind: 'invalid', reason: vector.reason });
    });

    it('an oversized DATA frame is invalid', () => {
        expect(frames.oversizeDataPayloadBytes).toBe(MAX_FRAME_PAYLOAD_BYTES + 1);
        const bytes = new Uint8Array(5 + frames.oversizeDataPayloadBytes);
        bytes.set([FrameType.DATA, 0, 0, 0, 1]);
        expect(decodeFrame(bytes)).toEqual({ kind: 'invalid', reason: 'payload-too-large' });
    });
});
