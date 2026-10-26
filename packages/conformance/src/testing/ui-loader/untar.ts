/** Reads the raw-block zstd frames the suite writes; anything compressed is refused (the fakes never need it). */
export function zstdUnstore(data: Uint8Array): Uint8Array {
    if (data[0] !== 0x28 || data[1] !== 0xb5 || data[2] !== 0x2f || data[3] !== 0xfd || data[4] !== 0xe0) {
        throw new Error('not a raw zstd frame');
    }
    const chunks: Uint8Array[] = [];
    let offset = 13;
    for (;;) {
        if (offset + 3 > data.length) throw new Error('truncated zstd frame');
        const header = (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8) | ((data[offset + 2] ?? 0) << 16);
        const size = header >> 3;
        if (((header >> 1) & 3) !== 0) throw new Error('not a raw block');
        offset += 3;
        if (offset + size > data.length) throw new Error('truncated zstd block');
        chunks.push(data.subarray(offset, offset + size));
        offset += size;
        if ((header & 1) === 1) break;
    }
    const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
    }
    return out;
}

export interface TarEntry {
    readonly path: string;
    readonly type: string;
    readonly bytes: Uint8Array<ArrayBuffer>;
}

const field = (block: Uint8Array, offset: number, length: number): string => {
    const raw = block.subarray(offset, offset + length);
    const end = raw.indexOf(0);
    return new TextDecoder().decode(end === -1 ? raw : raw.subarray(0, end));
};

export function readTarEntries(tar: Uint8Array): TarEntry[] {
    const entries: TarEntry[] = [];
    for (let offset = 0; offset + 512 <= tar.length;) {
        const block = tar.subarray(offset, offset + 512);
        if (block.every((byte) => byte === 0)) break;
        const size = Number.parseInt(field(block, 124, 12).trim() || '0', 8);
        const type = field(block, 156, 1) || '0';
        entries.push({ path: field(block, 0, 100), type, bytes: tar.slice(offset + 512, offset + 512 + size) });
        offset += 512 + Math.ceil(size / 512) * 512;
    }
    return entries;
}
