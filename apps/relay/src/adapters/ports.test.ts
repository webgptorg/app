import { describe, expect, it, vi } from 'vitest';

import type { Clock } from '../domain/clock';
import { createFakeClock } from './fake-clock';
import { createJsonLogger } from './json-logger';
import { createMemoryLogger } from './memory-logger';
import { createNodeRandom } from './node-random';
import { systemClock } from './system-clock';

describe.each<[string, Clock]>([
    ['systemClock', systemClock],
    ['fakeClock', createFakeClock(1_700_000_000_000)],
])('Clock %s', (_, clock) => {
    it('returns integer milliseconds since the epoch', () => {
        expect(Number.isInteger(clock.nowMs())).toBe(true);
        expect(clock.nowMs()).toBeGreaterThan(1_600_000_000_000);
    });

    it('never runs a cancelled timer', () => {
        const fn = vi.fn();
        clock.setTimeout(fn, 0)();
        expect(fn).not.toHaveBeenCalled();
    });
});

describe('system clock', () => {
    it('runs a timer once its time has come', async () => {
        await new Promise<void>((resolve) => systemClock.setTimeout(resolve, 1));
    });
});

describe('fake clock', () => {
    it('fires due timers in order, at their due time, and leaves later ones pending', () => {
        const clock = createFakeClock(0);
        const fired: string[] = [];
        clock.setTimeout(() => fired.push(`b@${String(clock.nowMs())}`), 20);
        clock.setTimeout(() => fired.push(`a@${String(clock.nowMs())}`), 10);
        clock.setTimeout(() => fired.push('late'), 31);
        clock.advance(30);
        expect(fired).toEqual(['a@10', 'b@20']);
        expect(clock.nowMs()).toBe(30);
        expect(clock.pendingTimers()).toBe(1);
    });

    it('fires a timer scheduled by another timer when it falls due within the same advance', () => {
        const clock = createFakeClock(0);
        const fired: number[] = [];
        clock.setTimeout(() => clock.setTimeout(() => fired.push(clock.nowMs()), 5), 5);
        clock.setTimeout(() => fired.push(-1), -5);
        clock.advance(10);
        expect(fired).toEqual([-1, 10]);
    });
});

describe('node random', () => {
    it('returns the requested number of bytes, different on each call', () => {
        const random = createNodeRandom();
        const first = random.bytes(32);
        expect(first).toHaveLength(32);
        expect(random.bytes(32)).not.toEqual(first);
    });
});

describe('JSON logger', () => {
    it('writes one JSON line per event with time, level and event first, which no field can overwrite', () => {
        const lines: string[] = [];
        const logger = createJsonLogger({
            level: 'info',
            clock: createFakeClock(0),
            write: (line) => lines.push(line),
        });
        logger.info('relay.started', { relayId: 'relay-a.ptbk.test', event: 'spoofed', level: 'error' } as never);
        logger.warn('registry.stale', { ageS: 1 });
        logger.error('relay.start-failed', { problem: 'x' });
        expect(lines).toEqual([
            '{"time":"1970-01-01T00:00:00.000Z","level":"info","event":"relay.started","relayId":"relay-a.ptbk.test"}',
            '{"time":"1970-01-01T00:00:00.000Z","level":"warn","event":"registry.stale","ageS":1}',
            '{"time":"1970-01-01T00:00:00.000Z","level":"error","event":"relay.start-failed","problem":"x"}',
        ]);
    });

    it('drops fields outside the event allowlist, even past the types', () => {
        const lines: string[] = [];
        const logger = createJsonLogger({
            level: 'info',
            clock: createFakeClock(0),
            write: (line) => lines.push(line),
        });
        logger.info('tunnel.connected', { engineId: 'e', browserIp: '192.0.2.1', sni: 'x.example' } as never);
        expect(lines).toEqual([
            '{"time":"1970-01-01T00:00:00.000Z","level":"info","event":"tunnel.connected","engineId":"e"}',
        ]);
    });

    it('drops events below its level', () => {
        const lines: string[] = [];
        const logger = createJsonLogger({
            level: 'warn',
            clock: createFakeClock(0),
            write: (line) => lines.push(line),
        });
        logger.info('relay.started', {});
        logger.warn('registry.stale', {});
        expect(lines.map((line) => (JSON.parse(line) as { event: string }).event)).toEqual(['registry.stale']);
    });

    it('writes to stdout by default', () => {
        const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        try {
            createJsonLogger({ level: 'info', clock: createFakeClock(0) }).info('relay.started', {});
            expect(write).toHaveBeenCalledWith(expect.stringMatching(/"event":"relay\.started"}\n$/));
        } finally {
            write.mockRestore();
        }
    });
});

describe('memory logger', () => {
    it('records entries with their level', () => {
        const logger = createMemoryLogger();
        logger.info('relay.stopped', {});
        logger.warn('registry.stale', { ageS: 1 });
        logger.error('relay.certificate-rejected', { problem: 'x' });
        expect(logger.entries).toEqual([
            { level: 'info', event: 'relay.stopped', fields: {} },
            { level: 'warn', event: 'registry.stale', fields: { ageS: 1 } },
            { level: 'error', event: 'relay.certificate-rejected', fields: { problem: 'x' } },
        ]);
    });

    it('throws on a field outside the event allowlist, so tests catch it', () => {
        const logger = createMemoryLogger();
        expect(() => {
            logger.info('tunnel.connected', { engineId: 'e', sni: 'x.example' } as never);
        }).toThrow('tunnel.connected may not log sni');
        expect(() => {
            logger.warn('unknown.event' as never, { a: 1 });
        }).toThrow('unknown.event may not log a');
        expect(logger.entries).toEqual([]);
    });
});
