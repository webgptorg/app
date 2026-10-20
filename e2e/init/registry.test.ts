import { describe, expect, it } from 'vitest';

import { parseIdentityReport, staticRegistry } from './registry.ts';

const ENGINE_ID = 'abcdefghijklmnopqrstuvwxyz';
const REPORT = {
    engineId: ENGINE_ID,
    enginePublicKey: 'A'.repeat(43),
    hostname: `${ENGINE_ID}.engine.test`,
};

describe('parseIdentityReport', () => {
    it('accepts the identity CLI report', () => {
        expect(parseIdentityReport(REPORT, 'engine.test')).toEqual(REPORT);
    });

    it('refuses anything else by field name', () => {
        expect(() => parseIdentityReport([REPORT], 'engine.test')).toThrow('not an object');
        expect(() => parseIdentityReport({ ...REPORT, extra: 1 }, 'engine.test')).toThrow('unknown fields: extra');
        expect(() => parseIdentityReport({ ...REPORT, engineId: 'ABC' }, 'engine.test')).toThrow('bad engineId');
        expect(() => parseIdentityReport({ ...REPORT, enginePublicKey: 'short' }, 'engine.test')).toThrow(
            'bad enginePublicKey',
        );
        expect(() => parseIdentityReport(REPORT, 'other.test')).toThrow('not the default one');
    });
});

describe('staticRegistry', () => {
    it("is R-02's static file with the engine's default hostname and no custom claims", () => {
        expect(staticRegistry(REPORT)).toEqual({
            v: 1,
            engines: [
                {
                    engineId: ENGINE_ID,
                    enginePublicKey: REPORT.enginePublicKey,
                    hostnames: [REPORT.hostname],
                    claims: [],
                    status: 'active',
                },
            ],
        });
    });
});
