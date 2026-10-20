import { createHash } from 'node:crypto';

import type { CloseCode } from '@ptbk/protocol';
import { CLOSE_CODE, FrameType, INITIAL_WINDOW_BYTES, MAX_FRAME_PAYLOAD_BYTES, encodeFrame } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import type { PeerStream } from '../testing/relay-stream-peer';
import type { StreamLoopback } from '../testing/stream-loopback';
import { createStreamLoopback } from '../testing/stream-loopback';
import type { TunnelDuplex } from './tunnel-duplex';
import { TunnelStreamError, openTunnelDuplex } from './tunnel-duplex';

const MIB = 1024 * 1024;

interface Harness {
    readonly loop: StreamLoopback;
    readonly duplex: TunnelDuplex;
    readonly peer: PeerStream;
}

async function connect(options: { readonly autoGrant?: boolean } = {}): Promise<Harness> {
    const duplexes: TunnelDuplex[] = [];
    const loop = createStreamLoopback((stream) => {
        const duplex = openTunnelDuplex(stream);
        duplexes.push(duplex);
        return duplex.events;
    }, options);
    const peer = loop.peer.open({
        family: 6,
        address: Uint8Array.of(0x20, 0x01, 0x0d, 0xb8, ...new Array<number>(11).fill(0), 1),
        port: 50_000,
    });
    await loop.settle();
    const duplex = duplexes[0];
    if (duplex === undefined) throw new Error('the engine did not open a duplex');
    return { loop, duplex, peer };
}

function pattern(length: number, seed: number): Buffer {
    const bytes = Buffer.alloc(length);
    for (let index = 0; index < length; index++) bytes[index] = (index * 31 + seed * 7 + (index >>> 9)) & 0xff;
    return bytes;
}

function sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function collect(duplex: TunnelDuplex): { bytes(): Buffer; waitFor(length: number): Promise<void> } {
    const chunks: Buffer[] = [];
    let length = 0;
    const waiters = new Set<() => void>();
    duplex.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        length += chunk.length;
        for (const waiter of [...waiters]) waiter();
    });
    return {
        bytes: () => Buffer.concat(chunks),
        waitFor: (target) =>
            new Promise((resolve) => {
                const check = (): void => {
                    if (length < target) return;
                    waiters.delete(check);
                    resolve();
                };
                waiters.add(check);
                check();
            }),
    };
}

function write(duplex: TunnelDuplex, bytes: Uint8Array | string): Promise<Error | null | undefined> {
    return new Promise((resolve) => {
        duplex.write(bytes, resolve);
    });
}

function nextError(duplex: TunnelDuplex): Promise<Error> {
    return new Promise((resolve) => duplex.once('error', resolve));
}

function nextEvent(duplex: TunnelDuplex, event: 'close' | 'end'): Promise<void> {
    return new Promise((resolve) => {
        duplex.once(event, () => {
            resolve();
        });
    });
}

function closeFrames(loop: StreamLoopback): CloseCode[] {
    return loop.framesFromEngine.flatMap((frame) => (frame.type === FrameType.CLOSE ? [frame.code] : []));
}

describe('TunnelDuplex', () => {
    it('exposes the client address from OPEN', async () => {
        const { duplex } = await connect();
        expect(duplex.streamId).toBe(1);
        expect(duplex.remoteAddress).toBe('2001:db8::1');
        expect(duplex.remotePort).toBe(50_000);
        expect(duplex.remoteFamily).toBe('IPv6');
    });

    it('moves 5 MB each way intact through a fake transport', async () => {
        const { loop, duplex, peer } = await connect();
        const toEngine = pattern(5 * MIB, 1);
        const toRelay = pattern(5 * MIB, 2);
        const received = collect(duplex);

        const [, written] = await Promise.all([
            peer.write(toEngine),
            write(duplex, toRelay),
            received.waitFor(toEngine.length),
            peer.waitForBytes(toRelay.length),
        ]);

        expect(written).toBeNull();
        expect(sha256(received.bytes())).toBe(sha256(toEngine));
        expect(sha256(peer.received())).toBe(sha256(toRelay));
        expect(loop.protocolErrors).toEqual([]);
        expect(loop.peer.errors()).toEqual([]);
        const dataFrames = loop.framesFromEngine.filter((frame) => frame.type === FrameType.DATA);
        expect(dataFrames.every((frame) => frame.payload.length <= MAX_FRAME_PAYLOAD_BYTES)).toBe(true);
    });

    it('stops granting credit to a slow consumer, so buffered bytes stay within one window', async () => {
        const { loop, duplex, peer } = await connect();
        let delivered = false;
        const writing = peer.write(pattern(MIB, 3)).then(() => {
            delivered = true;
        });

        await loop.settle();
        await loop.settle();
        expect(duplex.readableLength).toBe(INITIAL_WINDOW_BYTES);
        expect(peer.sendCredit()).toBe(0);
        expect(loop.framesFromEngine.filter((frame) => frame.type === FrameType.WINDOW)).toEqual([]);
        expect(delivered).toBe(false);

        const received = collect(duplex);
        await Promise.all([writing, received.waitFor(MIB)]);
        expect(received.bytes().equals(pattern(MIB, 3))).toBe(true);
        expect(loop.framesFromEngine.some((frame) => frame.type === FrameType.WINDOW)).toBe(true);
    });

    it('waits for WINDOW credit before writing past it', async () => {
        const { loop, duplex, peer } = await connect({ autoGrant: false });
        let done = false;
        const writing = write(duplex, pattern(INITIAL_WINDOW_BYTES + 1000, 4)).then((error) => {
            done = true;
            return error;
        });
        await loop.settle();
        expect(peer.receivedLength()).toBe(INITIAL_WINDOW_BYTES);
        expect(done).toBe(false);

        peer.grant(1000);
        expect(await writing).toBeNull();
        await loop.settle();
        expect(Buffer.from(peer.received()).equals(pattern(INITIAL_WINDOW_BYTES + 1000, 4))).toBe(true);
    });

    it('closes the tunnel when the relay sends DATA beyond the credit granted', async () => {
        const { loop, duplex } = await connect();
        const failed = nextError(duplex);
        const frame = encodeFrame({
            type: FrameType.DATA,
            streamId: duplex.streamId,
            payload: new Uint8Array(MAX_FRAME_PAYLOAD_BYTES),
        });
        for (let sent = 0; sent <= INITIAL_WINDOW_BYTES; sent += MAX_FRAME_PAYLOAD_BYTES) loop.peer.sendRaw(frame);
        await loop.settle();

        expect(loop.protocolErrors).toEqual(['flow-control']);
        expect(closeFrames(loop)).toEqual([CLOSE_CODE.FLOW_CONTROL]);
        const error = await failed;
        expect(error).toBeInstanceOf(TunnelStreamError);
        expect((error as TunnelStreamError).end).toEqual({ kind: 'flow-control' });
    });

    it('ends after the bytes still buffered when the relay closes normally', async () => {
        const { loop, duplex, peer } = await connect();
        await peer.write(Buffer.from('hello'));
        peer.close(CLOSE_CODE.NORMAL);
        await loop.settle();

        const received = collect(duplex);
        const closed = nextEvent(duplex, 'close');
        await nextEvent(duplex, 'end');
        await closed;
        expect(received.bytes().toString()).toBe('hello');
        expect(duplex.destroyed).toBe(true);
        expect(closeFrames(loop)).toEqual([]);
    });

    it('fails a write after the relay closed the stream', async () => {
        const { loop, duplex, peer } = await connect();
        peer.close(CLOSE_CODE.NORMAL);
        await loop.settle();
        const failed = nextError(duplex);
        const error = await write(duplex, 'late');
        expect(error).toBeInstanceOf(TunnelStreamError);
        expect(await failed).toBe(error);
        expect(closeFrames(loop)).toEqual([]);
    });

    it('fails a write that waits for credit when the relay closes normally', async () => {
        const { loop, duplex, peer } = await connect({ autoGrant: false });
        duplex.on('error', () => undefined);
        const writing = write(duplex, pattern(INITIAL_WINDOW_BYTES + 1, 5));
        await loop.settle();
        peer.close(CLOSE_CODE.NORMAL);
        const error = await writing;
        expect(error).toBeInstanceOf(TunnelStreamError);
        expect((error as TunnelStreamError).end).toEqual({ kind: 'remote', code: CLOSE_CODE.NORMAL });
    });

    it('is destroyed with an error naming the code when the relay resets the stream', async () => {
        const { loop, duplex, peer } = await connect({ autoGrant: false });
        const failed = nextError(duplex);
        const writing = write(duplex, pattern(INITIAL_WINDOW_BYTES + 1, 6));
        await loop.settle();
        peer.close(CLOSE_CODE.RESET);

        const error = await failed;
        expect(error).toBeInstanceOf(TunnelStreamError);
        expect(error.message).toContain('RESET');
        expect((error as TunnelStreamError).end).toEqual({ kind: 'remote', code: CLOSE_CODE.RESET });
        expect(await writing).toBeInstanceOf(Error);
        await loop.settle();
        expect(closeFrames(loop)).toEqual([]);
    });

    it('sends CLOSE NORMAL when ended, and ends its readable side', async () => {
        const { loop, duplex, peer } = await connect();
        duplex.resume();
        const ended = nextEvent(duplex, 'end');
        const closed = nextEvent(duplex, 'close');
        duplex.end('bye');
        await ended;
        await closed;
        expect(await peer.waitForClose()).toBe(CLOSE_CODE.NORMAL);
        expect(Buffer.from(peer.received()).toString()).toBe('bye');
        expect(closeFrames(loop)).toEqual([CLOSE_CODE.NORMAL]);
    });

    it('sends CLOSE NORMAL when destroyed, and RESET when destroyed with an error', async () => {
        const plain = await connect();
        plain.duplex.destroy();
        expect(await plain.peer.waitForClose()).toBe(CLOSE_CODE.NORMAL);

        const failing = await connect();
        failing.duplex.on('error', () => undefined);
        failing.duplex.destroy(new Error('tls failure'));
        expect(await failing.peer.waitForClose()).toBe(CLOSE_CODE.RESET);
        expect(closeFrames(failing.loop)).toEqual([CLOSE_CODE.RESET]);
    });

    it('fails a write that waits for credit when it is destroyed', async () => {
        const { loop, duplex } = await connect({ autoGrant: false });
        const writing = write(duplex, pattern(INITIAL_WINDOW_BYTES + 1, 7));
        await loop.settle();
        duplex.destroy();
        expect(await writing).toBeInstanceOf(Error);
    });

    it('is destroyed with an error when the tunnel is lost', async () => {
        const { loop, duplex } = await connect();
        const failed = nextError(duplex);
        loop.mux.closeAll();
        const error = await failed;
        expect((error as TunnelStreamError).end).toEqual({ kind: 'tunnel-lost' });
        expect(error.message).toContain('tunnel was lost');
        await loop.settle();
        expect(closeFrames(loop)).toEqual([]);
    });

    it('names an unknown close code by its number', () => {
        expect(new TunnelStreamError({ kind: 'remote', code: 9 as CloseCode }).message).toContain('(9)');
        expect(new TunnelStreamError({ kind: 'flow-control' }).name).toBe('TunnelStreamError');
    });
});
