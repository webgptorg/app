import { readFileSync } from 'node:fs';

/** wrangler.jsonc without its `//` comments and trailing commas; strings are copied untouched. */
function parseJsonc(text: string): unknown {
    let out = '';
    for (let index = 0; index < text.length; index++) {
        const char = text[index] as string;
        if (char === '"') {
            const end = text.indexOf('"', index + 1);
            let close = end;
            while (text[close - 1] === '\\') close = text.indexOf('"', close + 1);
            out += text.slice(index, close + 1);
            index = close;
        } else if (char === '/' && text[index + 1] === '/') {
            index = text.indexOf('\n', index) - 1;
        } else {
            out += char;
        }
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** The committed wrangler.jsonc, for tests that check it against the code. */
export function readWranglerConfig(): unknown {
    return parseJsonc(readFileSync(new URL('../../wrangler.jsonc', import.meta.url).pathname, 'utf8'));
}
