/**
 * A response body as text, reading at most `maxBytes`; null past it. A misbehaving server cannot make the Worker
 * buffer an unbounded answer.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
    if (reader === undefined) return '';
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            return null;
        }
        chunks.push(next.value);
    }
    const decoder = new TextDecoder();
    return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
}
