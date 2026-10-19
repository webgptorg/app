import { describe, expect, it } from 'vitest';

import type { Clock } from '../domain/ports/clock';
import type { Random } from '../domain/ports/random';
import { createConsoleLogger } from './console-logger';
import { cryptoRandom } from './crypto-random';
import { createFakeClock } from './fake-clock';
import { createFakeRandom } from './fake-random';
import { createMemoryLogger } from './memory-logger';
import { systemClock } from './system-clock';

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
        logger.warn('config.invalid', { paths: 'ENVIRONMENT' });
        expect(logger.entries).toEqual([{ level: 'warn', event: 'config.invalid', fields: { paths: 'ENVIRONMENT' } }]);
    });
});

describe('console logger', () => {
    it('writes one JSON line per event, base fields winning over event fields', () => {
        const lines: string[] = [];
        const original = console.error;
        console.error = (line: string) => lines.push(line);
        try {
            createConsoleLogger({ service: 'dashboard' }).error('http.unhandled-error', {
                service: 'spoof',
                error: 'TypeError',
            });
        } finally {
            console.error = original;
        }
        expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
            { service: 'dashboard', level: 'error', event: 'http.unhandled-error', error: 'TypeError' },
        ]);
    });
});
