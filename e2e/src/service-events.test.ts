import { describe, expect, it } from 'vitest';

import { eventsAfter, parseServiceEvents, parseTcpAttempt } from './service-events.ts';

const LOG = [
    '{"time":"2026-10-21T08:00:00.000Z","level":"info","event":"relay.started","relayId":"relay-a.ptbk.test"}',
    'tcpdump: listening on eth0',
    '{"time":"2026-10-21T08:00:01.500Z","level":"info","event":"tunnel.ready","relay":"wss://relay-a.ptbk.test"}',
    '{"time":"2026-10-21T08:00:02.000Z","level":"info","event":"tunnel.ready","relay":"wss://relay-b.ptbk.test"}',
    '{"broken json',
    '{"time":"yesterday","event":"tunnel.ready"}',
    '',
].join('\n');

describe('parseServiceEvents and eventsAfter', () => {
    it('keeps only JSON events with a time, and filters by name, time and fields', () => {
        const events = parseServiceEvents(LOG);
        expect(events.map((event) => event.event)).toEqual(['relay.started', 'tunnel.ready', 'tunnel.ready']);
        const since = Date.parse('2026-10-21T08:00:01.000Z');
        expect(eventsAfter(events, 'tunnel.ready', since)).toHaveLength(2);
        expect(
            eventsAfter(events, 'tunnel.ready', since, { relay: 'wss://relay-b.ptbk.test' }).map(
                (event) => event.timeMs,
            ),
        ).toEqual([Date.parse('2026-10-21T08:00:02.000Z')]);
        expect(eventsAfter(events, 'relay.started', since)).toEqual([]);
    });
});

describe('parseTcpAttempt', () => {
    it("reads tcp-check's output and refuses anything else", () => {
        expect(parseTcpAttempt('{"outcome":"timeout","banner":"","elapsedMs":3001}\n')).toEqual({
            outcome: 'timeout',
            banner: '',
            elapsedMs: 3001,
        });
        expect(() => parseTcpAttempt('{"outcome":"maybe"}')).toThrow('not a tcp-check result');
    });
});
