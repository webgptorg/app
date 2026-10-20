import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HEARTBEAT_MAX_BODY_BYTES, Heartbeat, buildHeartbeat } from './heartbeat';
import { EngineId, EngineVersion, Timestamp } from './ids';

const percent = fc.double({ min: 0, max: 100, noNaN: true });
const count = fc.integer({ min: 0, max: 1_000_000 });

const inputs = fc.record({
    engineId: fc.stringMatching(/^[a-z2-7]{26}$/).map((value) => EngineId.parse(value)),
    seq: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
    ts: fc
        .date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z'), noInvalidDate: true })
        .map((date) => Timestamp.parse(date.toISOString())),
    version: fc.tuple(fc.nat(999), fc.nat(999), fc.nat(999)).map((parts) => EngineVersion.parse(parts.join('.'))),
    uptimeS: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
    diskPct: percent,
    ramPct: percent,
    cpuLoad: fc.constantFrom('low', 'medium', 'high'),
    update: fc.constantFrom('none', 'available', 'pending', 'installing'),
    agents: count,
    members: count,
});

describe('buildHeartbeat (property)', () => {
    it('always parses with Heartbeat, with percentages in multiples of ten, under the size cap', () => {
        fc.assert(
            fc.property(inputs, (input) => {
                const body = buildHeartbeat(input);
                const heartbeat = Heartbeat.parse(JSON.parse(new TextDecoder().decode(body)));
                expect(heartbeat.diskPct % 10).toBe(0);
                expect(heartbeat.ramPct % 10).toBe(0);
                expect(Math.abs(heartbeat.diskPct - input.diskPct)).toBeLessThanOrEqual(5);
                expect(body.length).toBeLessThanOrEqual(HEARTBEAT_MAX_BODY_BYTES);
            }),
        );
    });
});
