import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { diagnosticRange } from './diagnostic-range';

const doc = Text.of(['Ada', 'PERSONA Research', 'META COLOR red']);
const range = (startLine: number, startColumn: number, endLine: number, endColumn: number) => ({
    startLine,
    startColumn,
    endLine,
    endColumn,
});

describe('diagnosticRange', () => {
    it('maps 1-based, end-inclusive positions to document offsets', () => {
        const { from, to } = diagnosticRange(doc, range(3, 6, 3, 10));

        expect(doc.sliceString(from, to)).toBe('COLOR');
    });

    it('spans lines', () => {
        const { from, to } = diagnosticRange(doc, range(1, 1, 2, 7));

        expect(doc.sliceString(from, to)).toBe('Ada\nPERSONA');
    });

    it('clamps lines and columns beyond the document instead of throwing', () => {
        expect(diagnosticRange(doc, range(9, 50, 12, 80))).toEqual({ from: doc.length, to: doc.length });
        const { from, to } = diagnosticRange(doc, range(1, 2, 1, 99));
        expect(doc.sliceString(from, to)).toBe('da');
    });

    it('never yields an end before the start', () => {
        expect(diagnosticRange(doc, range(2, 5, 1, 1))).toEqual({ from: 8, to: 8 });
    });
});
