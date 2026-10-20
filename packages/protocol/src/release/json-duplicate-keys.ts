/**
 * Whether any JSON object in `text` repeats a key, compared after unescaping (`"a"` and `"a"` are the same key),
 * at any depth. `JSON.parse` keeps the last duplicate while other parsers keep the first, so a signed payload with a
 * duplicate key could mean different things to different verifiers. Run before `JSON.parse`; on text that is not
 * JSON the answer is meaningless but it never throws, and `JSON.parse` rejects such text anyway.
 */
export function hasDuplicateJsonKeys(text: string): boolean {
    // One entry per open container: the keys seen so far for an object, `null` for an array.
    const containers: (Set<string> | null)[] = [];
    let expectingKey = false;
    let index = 0;
    while (index < text.length) {
        const char = text[index];
        if (char === '"') {
            const end = stringEnd(text, index);
            if (end < 0) return false;
            const keys = containers.at(-1);
            if (expectingKey && keys) {
                const key = decodeString(text.slice(index, end + 1));
                if (key === undefined) return false;
                if (keys.has(key)) return true;
                keys.add(key);
                expectingKey = false;
            }
            index = end + 1;
            continue;
        }
        if (char === '{') {
            containers.push(new Set());
            expectingKey = true;
        } else if (char === '[') {
            containers.push(null);
            expectingKey = false;
        } else if (char === '}' || char === ']') {
            containers.pop();
            expectingKey = false;
        } else if (char === ',') {
            expectingKey = containers.at(-1) instanceof Set;
        }
        index++;
    }
    return false;
}

function stringEnd(text: string, start: number): number {
    for (let index = start + 1; index < text.length; index++) {
        if (text[index] === '\\') index++;
        else if (text[index] === '"') return index;
    }
    return -1;
}

function decodeString(literal: string): string | undefined {
    try {
        const value: unknown = JSON.parse(literal);
        return typeof value === 'string' ? value : undefined;
    } catch {
        return undefined;
    }
}
