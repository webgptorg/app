import { describe, expect, it } from 'vitest';
import { TUNNEL_CLOSE_CODE } from './close';

describe('TUNNEL_CLOSE_CODE', () => {
    it('pins the contract values', () => {
        expect(TUNNEL_CLOSE_CODE).toEqual({
            REPLACED: 4000,
            AUTH_FAILED: 4001,
            PROTOCOL_ERROR: 4002,
            SHUTTING_DOWN: 4003,
            SUSPENDED: 4004,
        });
    });

    it('stays in the private range and is frozen', () => {
        for (const code of Object.values(TUNNEL_CLOSE_CODE)) {
            expect(code).toBeGreaterThanOrEqual(4000);
            expect(code).toBeLessThanOrEqual(4999);
        }
        expect(Object.isFrozen(TUNNEL_CLOSE_CODE)).toBe(true);
    });
});
