import { describe, expect, it } from 'vitest';
import { licenseCoverage } from './license-coverage';
import type { EngineLicenseUsage, LicenseGrant } from './license-contract';
const now = Date.parse('2026-11-13T00:00:00.000Z');
function grant(id: string, specialists: number, engineProjects: number | null = 1): LicenseGrant {
    return {
        id,
        validFrom: '2026-11-01T00:00:00.000Z',
        validUntil: null,
        capabilities: {
            engineProjects,
            specialists,
            controllingUsers: 5,
            harnessInstances: null,
            browserProfiles: 5,
            remoteControl: true,
        },
    };
}
function engine(id: string, specialists: number | null): EngineLicenseUsage {
    return {
        id,
        counts: {
            specialists,
            controllingUsers: 1,
            harnessInstances: 1,
            browserProfiles: 1,
        },
    };
}
describe('advisory license coverage', () => {
    it('rearranges heterogeneous grants without binding them to engines', () => {
        const result = licenseCoverage(
            [engine('small', 2), engine('large', 9)],
            [grant('business', 10), grant('start', 3)],
            now,
        );
        expect(result.assignments).toEqual({ small: 'start', large: 'business' });
        expect(result.warnings).toEqual([]);
        expect(result.blocking).toBe(false);
    });
    it('warns about missing, expired or insufficient grants without blocking', () => {
        const expired = {
            ...grant('expired', 10),
            validUntil: '2026-11-12T00:00:00.000Z',
        };
        expect(licenseCoverage([engine('large', 12)], [expired, grant('small', 3)], now)).toEqual({
            assignments: {},
            warnings: [{ engineId: 'large', reason: 'not-covered' }],
            blocking: false,
        });
    });
    it('retains unknown usage as unknown and supports unlimited project capacity', () => {
        const result = licenseCoverage([engine('one', null), engine('two', 3)], [grant('unlimited', 10, null)], now);
        expect(result.assignments).toEqual({ one: 'unlimited', two: 'unlimited' });
        expect(result.warnings).toEqual([{ engineId: 'one', reason: 'usage-unknown' }]);
    });
});
