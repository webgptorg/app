import { duplexPair } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { createFakeClock } from '../testing/fake-clock';
import { throttleDuplex } from './tunnel-throttle';

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(rate: () => number | null) {
    const clock = createFakeClock(0);
    const [tunnelSide, browserSide] = duplexPair();
    const throttled = throttleDuplex(tunnelSide, { clock, bytesPerS: rate });
    const received: Buffer[] = [];
    browserSide.on('data', (chunk: Buffer) => received.push(chunk));
    cleanups.push(() => {
        throttled.destroy();
        browserSide.destroy();
    });
    const receivedBytes = () => received.reduce((sum, chunk) => sum + chunk.length, 0);
    /** Advances fake time in small steps until `bytes` arrived; resolves with the fake time it took. */
    async function timeUntil(bytes: number, stepMs = 10): Promise<number> {
        for (let guard = 0; guard < 100_000; guard++) {
            await tick();
            if (receivedBytes() >= bytes) return clock.nowMs();
            clock.advance(stepMs);
        }
        throw new Error('bytes never arrived');
    }
    return { clock, tunnelSide, browserSide, throttled, received, receivedBytes, timeUntil };
}

describe('throttleDuplex', () => {
    it('delivers bytes towards the tunnel at the configured rate', async () => {
        const ctx = setup(() => 1000);
        const payload = Buffer.alloc(3000, 7);
        ctx.throttled.write(payload);
        const elapsedMs = await ctx.timeUntil(payload.length);
        expect(elapsedMs).toBeGreaterThanOrEqual(1900);
        expect(elapsedMs).toBeLessThanOrEqual(3100);
        expect(Buffer.concat(ctx.received)).toEqual(payload);
    });

    it('passes bytes straight through without a rate', async () => {
        const ctx = setup(() => null);
        ctx.throttled.write(Buffer.from('hello'));
        expect(await ctx.timeUntil(5)).toBe(0);
        expect(ctx.clock.pendingTimers()).toBe(0);
    });

    it('applies a rate change to the next slice', async () => {
        let rate: number | null = 100;
        const ctx = setup(() => rate);
        ctx.throttled.write(Buffer.alloc(10_000));
        await tick();
        ctx.clock.advance(50);
        await tick();
        expect(ctx.receivedBytes()).toBeLessThan(100);
        rate = null;
        expect(await ctx.timeUntil(10_000, 50)).toBeLessThanOrEqual(200);
    });

    it('passes browser bytes through untouched', async () => {
        const ctx = setup(() => 1);
        const chunks: Buffer[] = [];
        ctx.throttled.on('data', (chunk: Buffer) => chunks.push(chunk));
        ctx.browserSide.write(Buffer.from('from the browser'));
        await tick();
        await tick();
        expect(Buffer.concat(chunks).toString()).toBe('from the browser');
    });

    it('signals backpressure until the paced bytes are through', async () => {
        const ctx = setup(() => 64_000);
        let drained = false;
        const accepted = ctx.throttled.write(Buffer.alloc(64 * 1024));
        expect(accepted).toBe(false);
        ctx.throttled.once('drain', () => (drained = true));
        await ctx.timeUntil(64 * 1024, 100);
        expect(drained).toBe(false);
        // The write completes once the last slice's time has passed too.
        ctx.clock.advance(100);
        await tick();
        expect(drained).toBe(true);
    });

    it('waits for the tunnel to drain before the next slice', async () => {
        const ctx = setup(() => null);
        ctx.browserSide.pause();
        const big = Buffer.alloc(256 * 1024);
        ctx.throttled.write(big);
        ctx.throttled.write(Buffer.from('tail'));
        await tick();
        ctx.browserSide.resume();
        expect(await ctx.timeUntil(big.length + 4)).toBe(0);
        expect(Buffer.concat(ctx.received).subarray(-4).toString()).toBe('tail');
    });

    it('ends the tunnel side when the engine ends, and the engine side when the browser ends', async () => {
        const ctx = setup(() => null);
        let ended = false;
        ctx.throttled.on('end', () => (ended = true));
        ctx.throttled.resume();
        ctx.browserSide.end();
        ctx.throttled.end();
        await new Promise((resolve) => ctx.browserSide.once('end', resolve));
        await tick();
        expect(ended).toBe(true);
    });

    it('propagates destroy in both directions and stops pacing', async () => {
        const first = setup(() => 10);
        first.throttled.write(Buffer.alloc(1000));
        await tick();
        expect(first.clock.pendingTimers()).toBe(1);
        first.throttled.destroy();
        await tick();
        expect(first.tunnelSide.destroyed).toBe(true);
        expect(first.clock.pendingTimers()).toBe(0);

        const second = setup(() => null);
        second.tunnelSide.destroy();
        await tick();
        expect(second.throttled.destroyed).toBe(true);

        const third = setup(() => null);
        const errors: Error[] = [];
        third.throttled.on('error', (error) => errors.push(error));
        third.tunnelSide.destroy(new Error('tunnel lost'));
        await tick();
        expect(third.throttled.destroyed).toBe(true);
        expect(errors.map((error) => error.message)).toEqual(['tunnel lost']);
    });
});
