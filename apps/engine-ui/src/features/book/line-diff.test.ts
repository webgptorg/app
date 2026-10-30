import { describe, expect, it } from 'vitest';

import { countLineChanges, lineChanges } from './line-diff';

/** Applies the changes to `a`, taking the replacement text from `b`; must give back `b`. */
function apply(a: string, b: string): string {
    const changes = lineChanges(a, b);
    if (changes === null) throw new Error('no changes');
    let result = '';
    let position = 0;
    for (const change of changes) {
        result += a.slice(position, change.fromA) + b.slice(change.fromB, change.toB);
        position = change.toA;
    }
    return result + a.slice(position);
}

function spans(a: string, b: string): string[] {
    return (lineChanges(a, b) ?? []).map(
        ({ fromA, toA, fromB, toB }) => `-${a.slice(fromA, toA)}|+${b.slice(fromB, toB)}`,
    );
}

const CURRENT = 'Ada\nPERSONA A careful research assistant\nRULE Always cite sources\nFOO bar\nPERSONA';
const OLDER = 'Ada\nPERSONA A careful research assistant';

describe('lineChanges', () => {
    it('keeps an unchanged line whole instead of removing and adding it again', () => {
        expect(spans(CURRENT, OLDER)).toEqual(['-\nRULE Always cite sources\nFOO bar\nPERSONA|+']);
        expect(spans(OLDER, CURRENT)).toEqual(['-|+\nRULE Always cite sources\nFOO bar\nPERSONA']);
    });

    it('marks a changed line as one removed and one added line', () => {
        expect(spans('a\nb\nc', 'a\nB\nc')).toEqual(['-b\n|+B\n']);
    });

    it('handles changes at the start, the end and of the whole text', () => {
        expect(spans('a\nb', 'x\na\nb')).toEqual(['-|+x\n']);
        expect(spans('a\nb', 'a\nc')).toEqual(['-\nb|+\nc']);
        expect(spans('a', 'b')).toEqual(['-a|+b']);
        expect(spans('', 'a\nb')).toEqual(['-|+a\nb']);
        expect(spans('a\nb', 'a\nb')).toEqual([]);
    });

    it('produces changes that turn the first text into the second', () => {
        const pairs: [string, string][] = [
            [CURRENT, OLDER],
            ['a\nb\nc\nd\ne', 'a\nx\nc\ny\ne\nf'],
            ['one\n\ntwo\n', '\none\ntwo'],
            ['same\nsame\nsame', 'same'],
        ];
        for (const [a, b] of pairs) {
            expect(apply(a, b)).toBe(b);
            expect(apply(b, a)).toBe(a);
        }
    });

    it('gives up when there are more distinct lines than it can encode', () => {
        const many = Array.from({ length: 7000 }, (_, index) => `line ${String(index)}`).join('\n');
        expect(lineChanges(many, 'x')).toBeNull();
        expect(countLineChanges('x', many)).toBeNull();
    });
});

describe('countLineChanges', () => {
    it('counts added and removed lines', () => {
        expect(countLineChanges(OLDER, CURRENT)).toEqual({ added: 3, removed: 0 });
        expect(countLineChanges('a\nb\nc', 'a\nB\nc\nd')).toEqual({ added: 2, removed: 1 });
        expect(countLineChanges('a', 'a')).toEqual({ added: 0, removed: 0 });
    });
});
