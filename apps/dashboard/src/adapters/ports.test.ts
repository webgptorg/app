import { describe, expect, it, vi } from 'vitest';

import type { Clock } from '../domain/ports/clock';
import type { Random } from '../domain/ports/random';
import type { Timer } from '../domain/ports/timer';
import { createConsoleLogger } from './console-logger';
import { cryptoRandom } from './crypto-random';
import { createFakeClock } from './fake-clock';
import { createFakeRandom } from './fake-random';
import { createManualTimer } from '../testing/manual-timer';
import { createMemoryLogger } from './memory-logger';
import { systemClock } from './system-clock';
import { systemTimer } from './system-timer';

describe.each<[string, Clock]>([
    ['systemClock', systemClock],
    ['fakeClock', createFakeClock(1_700_000_000_000)],
])('Clock %s', (_, clock) => {
    it('returns integer milliseconds since the epoch', () => {
        expect(Number.isInteger(clock.nowMs())).toBe(true);
        expect(clock.nowMs()).toBeGreaterThan(1_600_000_000_000);
    });
});

describe.each<[string, Random]>([
    ['cryptoRandom', cryptoRandom],
    ['fakeRandom', createFakeRandom()],
])('Random %s', (_, random) => {
    it('returns the requested number of bytes, different on each call', () => {
        const first = random.bytes(16);
        expect(first).toHaveLength(16);
        expect(random.bytes(16)).not.toEqual(first);
    });
});

describe.each<[string, () => Timer]>([
    ['systemTimer', () => systemTimer],
    ['manualTimer', createManualTimer],
])('Timer %s', (_, makeTimer) => {
    it('ends a wait as soon as its signal aborts, and at once when it already has', async () => {
        const timer = makeTimer();
        const controller = new AbortController();
        const waiting = timer.wait(60_000, controller.signal);
        controller.abort();
        await expect(waiting).resolves.toBeUndefined();
        await expect(timer.wait(60_000, controller.signal)).resolves.toBeUndefined();
    });
});

describe('timers', () => {
    it('ends a system wait after its time', async () => {
        vi.useFakeTimers();
        try {
            let done = false;
            const waiting = systemTimer.wait(2000, new AbortController().signal).then(() => {
                done = true;
            });
            await vi.advanceTimersByTimeAsync(1999);
            expect(done).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await waiting;
            expect(done).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('ends manual waits only when told', async () => {
        const timer = createManualTimer();
        let done = false;
        const waiting = timer.wait(2000, new AbortController().signal).then(() => {
            done = true;
        });
        await Promise.resolve();
        expect([done, timer.pending()]).toEqual([false, 1]);
        timer.elapse();
        await waiting;
        expect([done, timer.pending()]).toEqual([true, 0]);
    });
});

describe('fake adapters', () => {
    it('move the fake clock only when told', () => {
        const clock = createFakeClock(10);
        clock.advance(5);
        expect(clock.nowMs()).toBe(15);
        clock.set(100);
        expect(clock.nowMs()).toBe(100);
    });

    it('make the fake random reproducible', () => {
        expect(createFakeRandom(7).bytes(4)).toEqual(createFakeRandom(7).bytes(4));
    });

    it('record log entries in memory', () => {
        const logger = createMemoryLogger();
        logger.info('boot');
        logger.warn('config.invalid', { paths: 'ENVIRONMENT' });
        expect(logger.entries).toEqual([
            { level: 'info', event: 'boot', fields: {} },
            { level: 'warn', event: 'config.invalid', fields: { paths: 'ENVIRONMENT' } },
        ]);
    });
});

describe('console logger', () => {
    it('writes one JSON line per event at its level, base fields winning over event fields', () => {
        const lines: string[] = [];
        const write = (line: string) => lines.push(line);
        vi.spyOn(console, 'info').mockImplementation(write);
        vi.spyOn(console, 'warn').mockImplementation(write);
        vi.spyOn(console, 'error').mockImplementation(write);
        try {
            const logger = createConsoleLogger({ service: 'dashboard' });
            logger.info('boot');
            logger.warn('slow', { ms: 900 });
            logger.error('http.unhandled-error', { service: 'spoof', error: 'TypeError' });
        } finally {
            vi.restoreAllMocks();
        }
        expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
            { service: 'dashboard', level: 'info', event: 'boot' },
            { ms: 900, service: 'dashboard', level: 'warn', event: 'slow' },
            { service: 'dashboard', level: 'error', event: 'http.unhandled-error', error: 'TypeError' },
        ]);
    });
});
