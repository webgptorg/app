import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hasDuplicateJsonKeys } from './json-duplicate-keys';

describe('hasDuplicateJsonKeys (property)', () => {
    it('never reports JSON.stringify output, which has no duplicate keys (property)', () => {
        fc.assert(
            fc.property(fc.jsonValue(), (value) => {
                expect(hasDuplicateJsonKeys(JSON.stringify(value))).toBe(false);
            }),
        );
    });

    it('finds a duplicate key in an object at any depth (property)', () => {
        const wrapper = fc.oneof(
            fc.record({ kind: fc.constant('object' as const), key: fc.string(), sibling: fc.jsonValue() }),
            fc.record({ kind: fc.constant('array' as const), key: fc.string(), sibling: fc.jsonValue() }),
        );
        fc.assert(
            fc.property(
                fc.string(),
                fc.jsonValue(),
                fc.jsonValue(),
                fc.array(wrapper, { maxLength: 6 }),
                (key, first, second, wrappers) => {
                    let text = `{${JSON.stringify(key)}:${JSON.stringify(first)},${JSON.stringify(key)}:${JSON.stringify(second)}}`;
                    for (const { kind, key: outer, sibling } of wrappers) {
                        text =
                            kind === 'object'
                                ? `{${JSON.stringify(outer)}:${text}}`
                                : `[${JSON.stringify(sibling)},${text}]`;
                    }
                    expect(hasDuplicateJsonKeys(text)).toBe(true);
                },
            ),
        );
    });

    it('never throws on arbitrary text (property)', () => {
        fc.assert(
            fc.property(fc.string({ unit: 'binary' }), (text) => {
                expect(() => hasDuplicateJsonKeys(text)).not.toThrow();
            }),
        );
        fc.assert(
            fc.property(fc.jsonValue(), fc.nat(), (value, cut) => {
                const text = JSON.stringify(value);
                expect(() => hasDuplicateJsonKeys(text.slice(0, cut % (text.length + 1)))).not.toThrow();
            }),
        );
    });
});
