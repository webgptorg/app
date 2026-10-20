import { describe, expect, it, vi } from 'vitest';

import { createFakeClock } from '../testing/fake-clock';
import { createJsonLogger } from './json-logger';

describe('createJsonLogger', () => {
    it('writes one JSON line per event with time, level and event first', () => {
        const lines: string[] = [];
        const logger = createJsonLogger({
            level: 'info',
            clock: createFakeClock(0),
            write: (line) => lines.push(line),
        });
        logger.info('tunnel.ready', { relay: 'wss://relay-a.example.test/v1/tunnel', attempt: 1 });
        logger.warn('tunnel.dial-failed', { reason: 'timeout' });
        logger.error('tunnel.replaced', { stopped: true });
        expect(lines).toEqual([
            '{"time":"1970-01-01T00:00:00.000Z","level":"info","event":"tunnel.ready","relay":"wss://relay-a.example.test/v1/tunnel","attempt":1}',
            '{"time":"1970-01-01T00:00:00.000Z","level":"warn","event":"tunnel.dial-failed","reason":"timeout"}',
            '{"time":"1970-01-01T00:00:00.000Z","level":"error","event":"tunnel.replaced","stopped":true}',
        ]);
    });

    it('drops events below the level', () => {
        const lines: string[] = [];
        const logger = createJsonLogger({
            level: 'warn',
            clock: createFakeClock(0),
            write: (line) => lines.push(line),
        });
        logger.info('tunnel.ready', {});
        logger.warn('tunnel.lost', {});
        expect(lines).toHaveLength(1);
    });

    it('never lets a field overwrite time, level or event', () => {
        const lines: string[] = [];
        const logger = createJsonLogger({
            level: 'info',
            clock: createFakeClock(0),
            write: (line) => lines.push(line),
        });
        logger.info('tunnel.ready', { time: 'x', level: 'error', event: 'forged' });
        expect(JSON.parse(lines[0] ?? '')).toEqual({
            time: '1970-01-01T00:00:00.000Z',
            level: 'info',
            event: 'tunnel.ready',
        });
    });

    it('writes to stdout by default', () => {
        const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        createJsonLogger({ level: 'info', clock: createFakeClock(0) }).info('mock-engine.started', {});
        expect(write).toHaveBeenCalledWith(
            '{"time":"1970-01-01T00:00:00.000Z","level":"info","event":"mock-engine.started"}\n',
        );
        write.mockRestore();
    });
});
