export interface PlaintextHaystack {
    readonly label: string;
    readonly bytes: Uint8Array;
}

export interface PlaintextHit {
    readonly needle: string;
    readonly label: string;
    readonly offset: number;
}

/** The first occurrence of each UTF-8 encoded needle in each haystack, in haystack order. */
export function findPlaintext(
    haystacks: readonly PlaintextHaystack[],
    needles: readonly string[],
): readonly PlaintextHit[] {
    const encoder = new TextEncoder();
    const encoded = needles.map((needle) => {
        if (needle.length === 0) throw new RangeError('an empty needle matches everywhere');
        return { needle, bytes: encoder.encode(needle) };
    });
    const hits: PlaintextHit[] = [];
    for (const { label, bytes } of haystacks) {
        const haystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (const { needle, bytes: needleBytes } of encoded) {
            const offset = haystack.indexOf(needleBytes);
            if (offset >= 0) hits.push({ needle, label, offset });
        }
    }
    return hits;
}
