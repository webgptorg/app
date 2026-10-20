import { describe, expect, it } from 'vitest';
import { hasDuplicateJsonKeys } from './json-duplicate-keys';

describe('hasDuplicateJsonKeys', () => {
    it.each([
        ['a top-level key', '{"a":1,"a":2}'],
        ['a key in a nested object', '{"a":{"b":1,"b":1}}'],
        ['a key in an object inside an array', '[1,{"x":[],"y":{},"x":null}]'],
        ['keys equal after unescaping', '{"a":1,"\\u0061":2}'],
        ['keys with escaped quotes', '{"a\\"b":1,"a\\u0022b":2}'],
        ['a key after a nested object', '{"a":{"z":1},"b":[{"c":2}],"a":3}'],
        ['whitespace around tokens', ' { "a" : 1 ,\n\t"a" : 2 } '],
        ['an empty key twice', '{"":1,"":2}'],
    ])('finds %s', (_, text) => {
        expect(hasDuplicateJsonKeys(text)).toBe(true);
    });

    it.each([
        ['distinct keys', '{"a":1,"b":2}'],
        ['the same key in sibling objects', '[{"a":1},{"a":2}]'],
        ['the same key in parent and child', '{"a":{"a":{"a":1}}}'],
        ['a value equal to a key', '{"a":"a","b":"a"}'],
        ['keys that differ only by case', '{"a":1,"A":2}'],
        ['braces and quotes inside strings', '{"a":"{\\"a\\":1,\\"a\\":2}","b":"[}"}'],
        ['a key after an array of strings', '{"a":["b","b"],"b":1}'],
        ['a scalar', '"a"'],
        ['an empty object', '{}'],
    ])('accepts %s', (_, text) => {
        expect(hasDuplicateJsonKeys(text)).toBe(false);
    });
});
