import { describe, expect, it } from 'vitest';

import { EventQueue, TIMED_OUT } from './event-queue';

describe('EventQueue', () => {
    it('hands out queued events first, then waits for the next', async () => {
        const queue = new EventQueue<number>();
        queue.push(1);
        expect(await queue.next(10)).toBe(1);
        const waiting = queue.next(1_000);
        queue.push(2);
        expect(await waiting).toBe(2);
    });

    it('times out, and finds the first matching event', async () => {
        const queue = new EventQueue<number>();
        expect(await queue.next(5)).toBe(TIMED_OUT);
        queue.push(1);
        queue.push(4);
        expect(await queue.find((item) => item > 2, 100)).toBe(4);
        expect(await queue.find((item) => item > 2, 5)).toBe(TIMED_OUT);
        expect(await queue.find(() => true, 0)).toBe(TIMED_OUT);
    });

    it('rejects when the signal aborts, before or while waiting', async () => {
        const queue = new EventQueue<number>();
        const aborted = new AbortController();
        aborted.abort(new Error('stop'));
        await expect(queue.next(1_000, aborted.signal)).rejects.toThrow('stop');
        const later = new AbortController();
        const waiting = queue.next(1_000, later.signal);
        later.abort('not an error');
        await expect(waiting).rejects.toThrow('aborted');
        queue.push(3);
        expect(queue.drain()).toEqual([3]);
    });
});
