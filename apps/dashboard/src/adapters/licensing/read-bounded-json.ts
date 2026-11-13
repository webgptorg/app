/** Bound the stream before allocating a full response; the website is a remote service. */
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('Empty response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) throw new Error('Response too large');
            chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } finally {
        await reader.cancel();
        reader.releaseLock();
    }
}
