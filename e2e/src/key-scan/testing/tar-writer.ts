// A minimal tar writer for tests, so fixtures are built at test time and cover the header variants Docker emits.

export interface TestTarEntry {
    readonly name: string;
    /** Typeflag character; `0` (regular file) by default. */
    readonly typeflag?: string;
    readonly content?: Uint8Array | string;
    readonly linkname?: string;
    /** Split off into the ustar prefix field. */
    readonly prefix?: string;
    readonly magic?: 'posix' | 'gnu';
    readonly base256Size?: boolean;
}

const BLOCK = 512;

function bytesOf(content: Uint8Array | string | undefined): Uint8Array {
    return typeof content === 'string' ? Buffer.from(content, 'utf8') : (content ?? new Uint8Array(0));
}

function writeOctal(block: Buffer, offset: number, width: number, value: number): void {
    block.write(`${value.toString(8).padStart(width - 1, '0')}\0`, offset, width, 'latin1');
}

function padded(bytes: Uint8Array): Buffer {
    return Buffer.concat([bytes, Buffer.alloc((BLOCK - (bytes.length % BLOCK)) % BLOCK)]);
}

export function tarHeader(entry: TestTarEntry, size: number): Buffer {
    const block = Buffer.alloc(BLOCK);
    block.write(entry.name, 0, 100, 'utf8');
    writeOctal(block, 100, 8, 0o644);
    writeOctal(block, 108, 8, 0);
    writeOctal(block, 116, 8, 0);
    if (entry.base256Size === true) {
        block[124] = 0x80;
        block.writeUIntBE(size, 136 - 6, 6);
    } else {
        writeOctal(block, 124, 12, size);
    }
    writeOctal(block, 136, 12, 0);
    block.write(entry.typeflag ?? '0', 156, 1, 'latin1');
    block.write(entry.linkname ?? '', 157, 100, 'utf8');
    block.write(entry.magic === 'gnu' ? 'ustar  \0' : 'ustar\x0000', 257, 8, 'latin1');
    block.write(entry.prefix ?? '', 345, 155, 'utf8');
    block.fill(0x20, 148, 156);
    const checksum = block.reduce((sum, byte) => sum + byte, 0);
    block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
    return block;
}

export function paxRecords(records: Readonly<Record<string, string>>): string {
    return Object.entries(records)
        .map(([key, value]) => {
            const body = ` ${key}=${value}\n`;
            let length = body.length + 1;
            while (String(length).length + Buffer.byteLength(body) !== length) length += 1;
            return `${String(length)}${body}`;
        })
        .join('');
}

export function tarArchive(entries: readonly TestTarEntry[]): Buffer {
    const parts = entries.flatMap((entry) => {
        const content = bytesOf(entry.content);
        return [tarHeader(entry, content.length), padded(content)];
    });
    return Buffer.concat([...parts, Buffer.alloc(2 * BLOCK)]);
}

export async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
    for (let offset = 0; offset < bytes.length; offset += size) {
        await Promise.resolve();
        yield bytes.subarray(offset, offset + size);
    }
}
