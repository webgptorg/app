import { describe, expect, it } from 'vitest';

import { MAX_IMPORT_ROWS, parseImportCsv } from './import-csv';

describe('password export CSV', () => {
    it('preserves quoted fields, empty cells, CRLF, escaped quotes and embedded newlines', () => {
        expect(parseImportCsv('name,user,password\r\n"A, B",," a""b\r\nc "\r\n\r\n')).toEqual({
            kind: 'rows',
            rows: [
                ['name', 'user', 'password'],
                ['A, B', '', ' a"b\r\nc '],
            ],
        });
        expect(parseImportCsv('a,b\rc,d')).toEqual({
            kind: 'rows',
            rows: [
                ['a', 'b'],
                ['c', 'd'],
            ],
        });
    });

    it.each(['"open', 'ab"cd,e', '"closed"tail,e', '"closed""', `${'a,'.repeat(129)}b`])(
        'rejects malformed CSV without exposing its contents',
        (csv) => {
            expect(parseImportCsv(csv)).toEqual({ kind: 'invalid' });
        },
    );

    it('bounds the number of records', () => {
        expect(parseImportCsv('h\n' + 'r\n'.repeat(MAX_IMPORT_ROWS)).kind).toBe('rows');
        expect(parseImportCsv('h\n' + 'r\n'.repeat(MAX_IMPORT_ROWS + 2))).toEqual({ kind: 'too-many' });
    });

    it('round trips combinations of password characters deterministically', () => {
        const cells = ['', ' ', ',a,', '"', 'a\nb', 'a\rb', 'a\r\nb', 'žluťoučký', '<script>', '=1+1'];
        const quote = (cell: string) => `"${cell.replaceAll('"', '""')}"`;
        for (const first of cells) {
            for (const second of cells) {
                const cells = [first, second, 'nonempty'];
                expect(parseImportCsv(cells.map(quote).join(','))).toEqual({ kind: 'rows', rows: [cells] });
            }
        }
    });
});
