export const MAX_IMPORT_ROWS = 1000;
const MAX_COLUMNS = 128;

export type CsvImportResult =
    | { readonly kind: 'rows'; readonly rows: readonly (readonly string[])[] }
    | { readonly kind: 'invalid' | 'too-many' };

/** Comma-separated exports: preserve passwords exactly, including quoted commas, quotes and line breaks. */
export function parseImportCsv(text: string): CsvImportResult {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;
    let closedQuote = false;
    const endCell = () => {
        row.push(cell);
        cell = '';
        closedQuote = false;
    };
    const endRow = () => {
        endCell();
        if (row.some((value) => value !== '')) rows.push(row);
        row = [];
    };
    for (let index = 0; index < text.length; index += 1) {
        const char = text.charAt(index);
        if (quoted) {
            if (char === '"') {
                if (text[index + 1] === '"') {
                    cell += '"';
                    index += 1;
                } else {
                    quoted = false;
                    closedQuote = true;
                }
            } else cell += char;
        } else if (char === ',') endCell();
        else if (char === '\r' || char === '\n') {
            endRow();
            if (char === '\r' && text[index + 1] === '\n') index += 1;
        } else if (char === '"' && cell === '' && !closedQuote) quoted = true;
        else {
            if (closedQuote || char === '"') return { kind: 'invalid' };
            cell += char;
        }
        if (row.length >= MAX_COLUMNS) return { kind: 'invalid' };
        // Include the header, but do not build an unbounded array from a small file of empty records.
        if (rows.length > MAX_IMPORT_ROWS + 1) return { kind: 'too-many' };
    }
    if (quoted) return { kind: 'invalid' };
    endRow();
    if (rows.length > MAX_IMPORT_ROWS + 1) return { kind: 'too-many' };
    return { kind: 'rows', rows };
}
