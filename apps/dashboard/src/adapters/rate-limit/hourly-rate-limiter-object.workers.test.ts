import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const HOUR = 60 * 60 * 1000;

function stub(name: string) {
    return env.HOURLY_RATE_LIMITER.get(env.HOURLY_RATE_LIMITER.idFromName(name));
}

describe('HourlyRateLimiter Durable Object', () => {
    it('allows the limit within a fixed window and limits after it', async () => {
        // Real time: the alarm is set for the window's end, and one in the past would fire at once.
        const start = Date.now();
        const counter = stub(`limit-${crypto.randomUUID()}`);
        for (let i = 0; i < 3; i++) {
            expect(await counter.consume(3, HOUR, start + i)).toBe('allowed');
        }
        expect(await counter.consume(3, HOUR, start + 10)).toBe('limited');
        expect(await counter.consume(3, HOUR, start + HOUR)).toBe('allowed');
    });

    it('keeps its state no longer than the window: the alarm at its end deletes everything', async () => {
        const counter = stub(`expiry-${crypto.randomUUID()}`);
        const start = Date.now();
        await counter.consume(1, HOUR, start);
        expect(await counter.consume(1, HOUR, start + 1)).toBe('limited');
        await runInDurableObject(counter, async (_, state) => {
            expect(await state.storage.getAlarm()).toBe(start + HOUR);
            expect([...(await state.storage.list()).keys()]).toEqual(['window']);
        });
        expect(await runDurableObjectAlarm(counter)).toBe(true);
        await runInDurableObject(counter, async (_, state) => {
            expect((await state.storage.list()).size).toBe(0);
        });
        expect(await counter.consume(1, HOUR, start + 2)).toBe('allowed');
    });

    // The first import of the whole Worker entry into workerd takes about 3 s on a 2-core CI runner even when nothing
    // else runs, too close to the 5 s default.
    it('is exported from the Worker entry next to the default handler', { timeout: 30_000 }, async () => {
        const entry = await import('../../worker');
        expect(entry.HourlyRateLimiter.name).toBe('HourlyRateLimiter');
    });
});
