import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_PROTOCOL_VERSION } from './constants';
import { TunnelFeature, negotiateTunnel, parseEngineMessage, parseRelayMessage } from './handshake';

const KINDS = new Set(['ok', 'invalid']);

describe('handshake parser properties', () => {
    it('never throws on arbitrary text', () => {
        fc.assert(
            fc.property(
                fc.oneof(fc.string({ maxLength: 64 }), fc.string({ unit: 'binary', maxLength: 5_000 })),
                (text) => {
                    expect(KINDS.has(parseRelayMessage(text).kind)).toBe(true);
                    expect(KINDS.has(parseEngineMessage(text).kind)).toBe(true);
                },
            ),
            { numRuns: 500 },
        );
    });

    it('never throws on arbitrary JSON values', () => {
        fc.assert(
            fc.property(fc.jsonValue({ maxDepth: 6 }), (value) => {
                const text = JSON.stringify(value);
                expect(KINDS.has(parseRelayMessage(text).kind)).toBe(true);
                expect(KINDS.has(parseEngineMessage(text).kind)).toBe(true);
            }),
            { numRuns: 500 },
        );
    });

    it('never throws on deeply nested JSON within the size limit', () => {
        expect(parseRelayMessage(`${'['.repeat(2_000)}${']'.repeat(2_000)}`)).toEqual({ kind: 'invalid' });
    });
});

describe('negotiateTunnel properties', () => {
    const versions = fc.uniqueArray(fc.integer({ min: 1, max: MAX_PROTOCOL_VERSION }), { minLength: 1, maxLength: 8 });
    const features = fc
        .uniqueArray(fc.stringMatching(/^[a-z0-9-]{1,4}$/), { maxLength: 32 })
        .map((names) => names.map((name) => TunnelFeature.parse(name)));

    it('picks the highest common version and exactly the sorted intersection, symmetrically', () => {
        fc.assert(
            fc.property(versions, features, versions, features, (rv, rf, ev, ef) => {
                const relay = { versions: rv, features: rf };
                const engine = { versions: ev, features: ef };
                const result = negotiateTunnel(relay, engine);
                expect(negotiateTunnel(engine, relay)).toEqual(result);
                const common = rv.filter((version) => ev.includes(version));
                if (common.length === 0) {
                    expect(result).toEqual({ kind: 'unsupported-version' });
                    return;
                }
                const shared = rf.filter((feature) => ef.includes(feature));
                expect(result).toEqual({
                    kind: 'ok',
                    protocolVersion: Math.max(...common),
                    features: [...shared].sort((a, b) => (a < b ? -1 : 1)),
                });
            }),
            { numRuns: 300 },
        );
    });
});
