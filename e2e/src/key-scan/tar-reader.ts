// A streaming reader for the tar archives the Docker Engine API emits (Go's archive/tar: ustar, PAX and GNU long
// names). It holds one entry's content at a time, never the whole archive, and refuses anything it cannot read in
// full: a scan that silently skipped bytes would prove nothing.

export type TarEntryType = 'file' | 'directory' | 'symlink' | 'hardlink' | 'other';

export interface TarEntry {
    readonly path: string;
    readonly type: TarEntryType;
    readonly size: number;
    /** The file's bytes for `file` entries; empty for every other type. */
    readonly content: Uint8Array;
}

export interface ReadTarOptions {
    /** Largest regular file accepted; a bigger one throws instead of being buffered. */
    readonly maxFileBytes?: number;
}

export class TarFormatError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TarFormatError';
    }
}

const BLOCK = 512;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const POSIX_MAGIC = new TextEncoder().encode('ustar\0');

/** Types whose size field describes no data in the archive (as Go's reader treats them). */
const HEADER_ONLY: Readonly<Record<string, TarEntryType>> = {
    '1': 'hardlink',
    '2': 'symlink',
    '3': 'other',
    '4': 'other',
    '5': 'directory',
    '6': 'other',
};

const decoder = new TextDecoder();

class ChunkReader {
    readonly #iterator: AsyncIterator<Uint8Array>;
    #pending: Uint8Array = new Uint8Array(0);

    constructor(source: AsyncIterable<Uint8Array>) {
        this.#iterator = source[Symbol.asyncIterator]();
    }

    async read(length: number, what: string): Promise<Uint8Array> {
        const out = new Uint8Array(length);
        let filled = 0;
        await this.#consume(length, what, (part) => {
            out.set(part, filled);
            filled += part.length;
        });
        return out;
    }

    async skip(length: number, what: string): Promise<void> {
        await this.#consume(length, what, () => undefined);
    }

    /** True at the end of the source, without consuming anything. */
    async atEnd(): Promise<boolean> {
        while (this.#pending.length === 0) {
            const next = await this.#iterator.next();
            if (next.done === true) return true;
            this.#pending = next.value;
        }
        return false;
    }

    async close(): Promise<void> {
        await this.#iterator.return?.();
    }

    async #consume(length: number, what: string, sink: (part: Uint8Array) => void): Promise<void> {
        let remaining = length;
        while (remaining > 0) {
            if (await this.atEnd()) throw new TarFormatError(`truncated archive in ${what}`);
            const part = this.#pending.subarray(0, remaining);
            sink(part);
            this.#pending = this.#pending.subarray(part.length);
            remaining -= part.length;
        }
    }
}

function padding(size: number): number {
    return (BLOCK - (size % BLOCK)) % BLOCK;
}

function text(bytes: Uint8Array): string {
    const end = bytes.indexOf(0);
    return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function octal(field: Uint8Array, what: string): number {
    const digits = text(field)
        .replace(/[ \0]+$/, '')
        .trimStart();
    if (!/^[0-7]*$/.test(digits)) throw new TarFormatError(`malformed ${what} field`);
    return digits === '' ? 0 : Number.parseInt(digits, 8);
}

/** Sizes of 8 GiB and more use base-256: the high bit of the first byte is set, the rest is big-endian. */
function numeric(field: Uint8Array, what: string): number {
    const [first] = field;
    if (first === undefined || (first & 0x80) === 0) return octal(field, what);
    if ((first & 0x40) !== 0) throw new TarFormatError(`negative ${what} field`);
    let value = BigInt(first & 0x3f);
    for (const byte of field.subarray(1)) value = (value << 8n) | BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new TarFormatError(`${what} field out of range`);
    return Number(value);
}

function isZeroBlock(block: Uint8Array): boolean {
    return block.every((byte) => byte === 0);
}

function verifyChecksum(header: Uint8Array): void {
    const expected = octal(header.subarray(148, 156), 'checksum');
    let unsigned = 0;
    let signed = 0;
    for (const [index, byte] of header.entries()) {
        const value = index >= 148 && index < 156 ? 0x20 : byte;
        unsigned += value;
        signed += value > 0x7f ? value - 0x100 : value;
    }
    // Some historic writers summed signed bytes; Go's reader accepts both, and so does this one.
    if (expected !== unsigned && expected !== signed) throw new TarFormatError('header checksum mismatch');
}

function headerPath(header: Uint8Array): string {
    const name = text(header.subarray(0, 100));
    // GNU headers carry other fields where ustar keeps the prefix.
    if (!header.subarray(257, 263).every((byte, index) => byte === POSIX_MAGIC[index])) return name;
    const prefix = text(header.subarray(345, 500));
    return prefix === '' ? name : `${prefix}/${name}`;
}

interface PaxOverrides {
    path?: string;
    size?: number;
}

function parsePax(data: Uint8Array): PaxOverrides {
    const overrides: PaxOverrides = {};
    let offset = 0;
    while (offset < data.length) {
        const space = data.indexOf(0x20, offset);
        const digits = space === -1 ? '' : text(data.subarray(offset, space));
        const end = offset + (/^[1-9]\d*$/.test(digits) ? Number(digits) : 0);
        if (end <= space || end > data.length || data[end - 1] !== 0x0a)
            throw new TarFormatError('malformed PAX record');
        const record = decoder.decode(data.subarray(space + 1, end - 1));
        const equals = record.indexOf('=');
        if (equals === -1) throw new TarFormatError('malformed PAX record');
        const key = record.slice(0, equals);
        const value = record.slice(equals + 1);
        if (key === 'path') overrides.path = value;
        if (key === 'size') {
            if (!/^\d+$/.test(value)) throw new TarFormatError('malformed PAX size');
            overrides.size = Number(value);
        }
        offset = end;
    }
    return overrides;
}

/** Yields every entry of a tar stream in order; throws on a corrupt, truncated or oversized archive. */
export async function* readTar(
    source: AsyncIterable<Uint8Array>,
    options: ReadTarOptions = {},
): AsyncGenerator<TarEntry> {
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const reader = new ChunkReader(source);
    try {
        let next: PaxOverrides = {};
        for (;;) {
            const header = await reader.read(BLOCK, 'header');
            if (isZeroBlock(header)) {
                if (!isZeroBlock(await reader.read(BLOCK, 'end of archive'))) {
                    throw new TarFormatError('malformed end of archive');
                }
                return;
            }
            verifyChecksum(header);
            const typeflag = String.fromCharCode(header[156] ?? 0);
            const headerSize = numeric(header.subarray(124, 136), 'size');

            if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L' || typeflag === 'K') {
                if (headerSize > MAX_METADATA_BYTES) throw new TarFormatError(`oversized ${typeflag} header`);
                const data = await reader.read(headerSize, 'extended header');
                await reader.skip(padding(headerSize), 'extended header');
                if (typeflag === 'x') next = { ...next, ...parsePax(data) };
                if (typeflag === 'L') next = { ...next, path: text(data) };
                continue;
            }
            const path = next.path ?? headerPath(header);
            const size = next.size ?? headerSize;
            next = {};

            const headerOnly = HEADER_ONLY[typeflag];
            if (headerOnly !== undefined) {
                yield { path, type: headerOnly, size: 0, content: new Uint8Array(0) };
                continue;
            }
            if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '7') {
                // Data we would not scan (GNU sparse files, vendor types): refuse rather than skip it.
                if (size > 0) throw new TarFormatError(`${path}: unsupported entry type ${JSON.stringify(typeflag)}`);
                yield { path, type: 'other', size: 0, content: new Uint8Array(0) };
                continue;
            }
            if (size > maxFileBytes) {
                throw new TarFormatError(`${path}: ${String(size)} bytes exceeds the ${String(maxFileBytes)}-byte cap`);
            }
            const content = await reader.read(size, path);
            await reader.skip(padding(size), path);
            yield { path, type: 'file', size, content };
        }
    } finally {
        await reader.close();
    }
}
