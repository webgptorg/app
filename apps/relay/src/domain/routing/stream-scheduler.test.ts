import { beforeEach, describe, expect, it } from 'vitest';

import type { FakeTransport } from '../../testing/fake-transport';
import { createFakeTransport } from '../../testing/fake-transport';
import { createTestDeps } from '../../testing/test-deps';
import type { SchedulerSink, StreamScheduler } from './stream-scheduler';
import {
    SCHEDULER_SLICE_BYTES,
    TUNNEL_HIGH_WATER_BYTES,
    TUNNEL_LOW_WATER_BYTES,
    createStreamScheduler,
} from './stream-scheduler';

interface Write {
    readonly stream: string;
    readonly bytes: number;
}

interface FakeSink extends SchedulerSink {
    credit: number;
}

const KIB = 1024;

describe('createStreamScheduler', () => {
    let tunnel: FakeTransport;
    let writes: Write[];
    let pauses: number[];
    let clock: ReturnType<typeof createTestDeps>['clock'];
    let scheduler: StreamScheduler;
    /** When set, every write lands in the tunnel's buffer, as on a WebSocket that does not drain. */
    let buffering: boolean;

    beforeEach(() => {
        tunnel = createFakeTransport();
        writes = [];
        pauses = [];
        buffering = false;
        ({ clock } = createTestDeps());
        scheduler = createStreamScheduler({
            tunnel,
            throttle: () => pauses.shift() ?? 0,
            clock,
        });
    });

    /** A stream with `credit` bytes of credit; like `TunnelStream.write`, it reports `false` once that runs out. */
    function sink(name: string, credit = Number.MAX_SAFE_INTEGER): FakeSink {
        return {
            credit,
            write(bytes) {
                writes.push({ stream: name, bytes: bytes.length });
                if (buffering) tunnel.setBufferedBytes(tunnel.bufferedBytes() + bytes.length);
                this.credit -= bytes.length;
                return this.credit >= 0;
            },
        };
    }

    const bytes = (size: number): Uint8Array => new Uint8Array(size);
    const written = (stream: string): number =>
        writes.filter((write) => write.stream === stream).reduce((total, write) => total + write.bytes, 0);

    it('writes a batch in slices and reports it sent once all of it is within credit', () => {
        const stream = scheduler.add(sink('a'));
        let sent = 0;
        stream.submit(bytes(2 * SCHEDULER_SLICE_BYTES + 100), () => sent++);
        expect(writes.map((write) => write.bytes)).toEqual([SCHEDULER_SLICE_BYTES, SCHEDULER_SLICE_BYTES, 100]);
        expect(sent).toBe(1);
        expect(stream.pendingBytes()).toBe(0);
        stream.submit(bytes(1), () => sent++);
        expect(sent).toBe(2);
    });

    it('takes turns between streams, so a small message is not stuck behind a large one', () => {
        tunnel.setBufferedBytes(TUNNEL_HIGH_WATER_BYTES);
        const large = scheduler.add(sink('large'));
        const small = scheduler.add(sink('small'));
        const order: string[] = [];
        large.submit(bytes(4 * SCHEDULER_SLICE_BYTES), () => order.push('large'));
        small.submit(bytes(100), () => order.push('small'));
        expect(writes).toEqual([]);
        expect(large.pendingBytes()).toBe(4 * SCHEDULER_SLICE_BYTES);
        tunnel.setBufferedBytes(TUNNEL_LOW_WATER_BYTES - 1);
        expect(writes.map((write) => write.stream)).toEqual(['large', 'small', 'large', 'large', 'large']);
        expect(order).toEqual(['small', 'large']);
    });

    it('stops every stream at the high-water mark and resumes only below the low-water mark', () => {
        buffering = true;
        tunnel.setBufferedBytes(TUNNEL_HIGH_WATER_BYTES);
        const a = scheduler.add(sink('a'));
        const b = scheduler.add(sink('b'));
        a.submit(bytes(2 * TUNNEL_HIGH_WATER_BYTES), () => undefined);
        b.submit(bytes(2 * TUNNEL_HIGH_WATER_BYTES), () => undefined);
        tunnel.setBufferedBytes(0);
        expect(tunnel.bufferedBytes()).toBe(TUNNEL_HIGH_WATER_BYTES);
        expect(written('a')).toBe(written('b'));
        const before = writes.length;
        tunnel.setBufferedBytes(TUNNEL_LOW_WATER_BYTES);
        expect(writes).toHaveLength(before);
        tunnel.setBufferedBytes(TUNNEL_LOW_WATER_BYTES - 1);
        expect(tunnel.bufferedBytes()).toBeGreaterThanOrEqual(TUNNEL_HIGH_WATER_BYTES);
        expect(tunnel.bufferedBytes()).toBeLessThan(TUNNEL_HIGH_WATER_BYTES + SCHEDULER_SLICE_BYTES);
        expect(writes.length).toBeGreaterThan(before);
    });

    it('holds a stream out of credit until its credit returns, without holding up the others', () => {
        const slowSink = sink('slow', 20 * KIB);
        const slow = scheduler.add(slowSink);
        const fast = scheduler.add(sink('fast'));
        let slowSent = false;
        slow.submit(bytes(64 * KIB), () => (slowSent = true));
        expect(written('slow')).toBe(32 * KIB);
        expect(slow.pendingBytes()).toBe(32 * KIB);
        let fastSent = false;
        fast.submit(bytes(10 * KIB), () => (fastSent = true));
        expect(fastSent).toBe(true);
        expect(written('slow')).toBe(32 * KIB);
        slowSink.credit = 1_000_000;
        slow.creditReturned();
        expect(written('slow')).toBe(64 * KIB);
        expect(slowSent).toBe(true);
        slow.creditReturned();
    });

    it('reports a batch sent only when the credit for its last slice returns', () => {
        const tight = sink('tight', SCHEDULER_SLICE_BYTES - 1);
        const stream = scheduler.add(tight);
        let sent = false;
        stream.submit(bytes(SCHEDULER_SLICE_BYTES), () => (sent = true));
        expect(stream.pendingBytes()).toBe(0);
        expect(sent).toBe(false);
        expect(() => {
            stream.submit(bytes(1), () => undefined);
        }).toThrow('a batch is already in flight');
        stream.creditReturned();
        expect(sent).toBe(true);
    });

    it('pauses when the engine is over its bandwidth budget and resumes when the clock says', () => {
        const stream = scheduler.add(sink('a'));
        pauses.push(0, 100);
        stream.submit(bytes(4 * SCHEDULER_SLICE_BYTES), () => undefined);
        expect(writes).toHaveLength(2);
        clock.advance(99);
        expect(writes).toHaveLength(2);
        clock.advance(1);
        expect(writes).toHaveLength(4);
    });

    it('drops the batch of a removed stream and never reports it sent', () => {
        tunnel.setBufferedBytes(TUNNEL_HIGH_WATER_BYTES);
        const removed = scheduler.add(sink('removed'));
        let sent = false;
        removed.submit(bytes(100), () => (sent = true));
        removed.remove();
        removed.remove();
        expect(removed.pendingBytes()).toBe(0);
        tunnel.setBufferedBytes(0);
        expect(writes).toEqual([]);
        expect(sent).toBe(false);
        const blocked = scheduler.add(sink('blocked', 0));
        blocked.submit(bytes(10), () => (sent = true));
        blocked.remove();
        blocked.creditReturned();
        expect(sent).toBe(false);
    });
});
