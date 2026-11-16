/** Bound the stream before allocating a full response; the website is a remote service. */
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
    if (response.body === null) throw new Error('Empty response');
    // Workers types leave the chunk type open; a fetch body yields bytes.
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > maxBytes) throw new Error('Response too large');
            chunks.push(next.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
    } finally {
        await reader.cancel();
        reader.releaseLock();
    }
}
