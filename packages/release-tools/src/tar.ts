import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A regular file inside the archive; `path` is relative, `/`-separated. */
export interface TarFile {
    readonly path: string;
    readonly bytes: Uint8Array<ArrayBuffer>;
}

export interface TarOptions {
    /** `SOURCE_DATE_EPOCH`, seconds. */
    readonly mtime: number;
    /** Written before every other entry (the manifest, so a streaming reader sees it first). */
    readonly first: string;
}

const BLOCK = 512;
// POSIX record size: readers that insist on whole records accept the archive, and it costs nothing after zstd.
const RECORD = 20 * BLOCK;
const NAME_BYTES = 100;
const PREFIX_BYTES = 155;
const FILE_MODE = 0o644;
const DIRECTORY_MODE = 0o755;
/** 11 octal digits, the ustar size field without extensions. */
const MAX_FILE_BYTES = 8 ** 11 - 1;

export const TAR_LIMITS = Object.freeze({ maxEntries: 10_000, maxUnpackedBytes: 200 * 1024 * 1024 });

const ascii = new TextEncoder();
const latin1 = new TextDecoder('latin1');

export class TarPathError extends Error {
    override readonly name = 'TarPathError';
}

/**
 * Refuses everything a reader could resolve outside the archive root or differently on another system: absolute
 * paths, `.` and `..`, empty segments, backslashes and anything outside printable ASCII.
 */
export function assertSafePath(path: string): void {
    if (path === '' || path.startsWith('/')) throw new TarPathError(`not a relative path: ${JSON.stringify(path)}`);
    if (!/^[\x21-\x7e]+$/.test(path) || path.includes('\\')) {
        throw new TarPathError(`path outside printable ASCII or with a backslash: ${JSON.stringify(path)}`);
    }
    for (const segment of path.split('/')) {
        if (segment === '' || segment === '.' || segment === '..') {
            throw new TarPathError(`empty, "." or ".." segment: ${JSON.stringify(path)}`);
        }
    }
}

/** Byte order, never `localeCompare`: the archive must not depend on the build machine's locale. */
export function compareBytes(a: string, b: string): number {
    if (a === b) return 0;
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function splitPath(path: string): { readonly name: string; readonly prefix: string } {
    if (path.length <= NAME_BYTES) return { name: path, prefix: '' };
    for (let cut = path.indexOf('/'); cut !== -1; cut = path.indexOf('/', cut + 1)) {
        const prefix = path.slice(0, cut);
        const name = path.slice(cut + 1);
        if (prefix.length <= PREFIX_BYTES && name !== '' && name.length <= NAME_BYTES) return { name, prefix };
    }
    throw new TarPathError(`path does not fit a ustar header: ${JSON.stringify(path)}`);
}

function writeField(header: Uint8Array, offset: number, length: number, value: string): void {
    const bytes = ascii.encode(value);
    if (bytes.length > length) throw new RangeError(`tar field over ${String(length)} bytes`);
    header.set(bytes, offset);
}

function octal(value: number, digits: number): string {
    return value.toString(8).padStart(digits, '0');
}

function header(path: string, type: 'file' | 'directory', size: number, mtime: number): Uint8Array {
    const block = new Uint8Array(BLOCK);
    const { name, prefix } = splitPath(path);
    writeField(block, 0, NAME_BYTES, name);
    writeField(block, 100, 8, `${octal(type === 'file' ? FILE_MODE : DIRECTORY_MODE, 7)}\0`);
    writeField(block, 108, 8, `${octal(0, 7)}\0`);
    writeField(block, 116, 8, `${octal(0, 7)}\0`);
    writeField(block, 124, 12, `${octal(size, 11)}\0`);
    writeField(block, 136, 12, `${octal(mtime, 11)}\0`);
    writeField(block, 148, 8, ' '.repeat(8));
    writeField(block, 156, 1, type === 'file' ? '0' : '5');
    writeField(block, 257, 6, 'ustar\0');
    writeField(block, 263, 2, '00');
    // uname, gname, devmajor and devminor stay zero-filled: empty owner names, no device.
    writeField(block, 345, PREFIX_BYTES, prefix);
    const checksum = block.reduce((sum, byte) => sum + byte, 0);
    writeField(block, 148, 8, `${octal(checksum, 6)}\0 `);
    return block;
}

function directoriesOf(paths: readonly string[]): string[] {
    const directories = new Set<string>();
    for (const path of paths) {
        const segments = path.split('/');
        for (let depth = 1; depth < segments.length; depth += 1) {
            directories.add(`${segments.slice(0, depth).join('/')}/`);
        }
    }
    return [...directories];
}

/**
 * A deterministic ustar archive: `first`, then every directory and file sorted by bytes; mtime `options.mtime`,
 * uid/gid 0, empty owner names, 0644 files and 0755 directories, no extended headers. The same files in any order
 * produce the same bytes.
 */
export function writeTar(files: readonly TarFile[], options: TarOptions): Uint8Array {
    if (!Number.isSafeInteger(options.mtime) || options.mtime < 0) throw new RangeError('mtime must be seconds ≥ 0');
    const byPath = new Map<string, TarFile>();
    for (const file of files) {
        assertSafePath(file.path);
        if (byPath.has(file.path)) throw new TarPathError(`duplicate path: ${JSON.stringify(file.path)}`);
        if (file.bytes.length > MAX_FILE_BYTES) throw new RangeError(`file too large for ustar: ${file.path}`);
        byPath.set(file.path, file);
    }
    if (!byPath.has(options.first)) throw new TarPathError(`missing first entry: ${JSON.stringify(options.first)}`);
    const directories = directoriesOf([...byPath.keys()]);
    if (directories.some((directory) => byPath.has(directory.slice(0, -1)))) {
        throw new TarPathError('a path is both a file and a directory');
    }
    const rest = [...directories, ...[...byPath.keys()].filter((path) => path !== options.first)].sort(compareBytes);

    const chunks: Uint8Array[] = [];
    for (const path of [options.first, ...rest]) {
        const file = byPath.get(path);
        if (file === undefined) {
            chunks.push(header(path, 'directory', 0, options.mtime));
            continue;
        }
        chunks.push(header(path, 'file', file.bytes.length, options.mtime), file.bytes);
        const padding = (BLOCK - (file.bytes.length % BLOCK)) % BLOCK;
        if (padding > 0) chunks.push(new Uint8Array(padding));
    }

    const body = chunks.reduce((total, chunk) => total + chunk.length, 0) + 2 * BLOCK;
    const archive = new Uint8Array(Math.ceil(body / RECORD) * RECORD);
    let offset = 0;
    for (const chunk of chunks) {
        archive.set(chunk, offset);
        offset += chunk.length;
    }
    return archive;
}

function field(block: Uint8Array, offset: number, length: number): string {
    const raw = block.subarray(offset, offset + length);
    const end = raw.indexOf(0);
    return latin1.decode(end === -1 ? raw : raw.subarray(0, end));
}

function octalField(block: Uint8Array, offset: number, length: number, what: string): number {
    const text = field(block, offset, length).trim();
    if (!/^[0-7]{1,11}$/.test(text)) throw new TarFormatError(`bad ${what} field`);
    return Number.parseInt(text, 8);
}

export class TarFormatError extends Error {
    override readonly name = 'TarFormatError';
}

/**
 * Reads only what `writeTar` writes: ustar regular files and directories with valid checksums and safe, unique
 * paths, within `TAR_LIMITS`. Links, devices, extended headers and anything after the end marker are refused.
 */
export function readTar(archive: Uint8Array): TarFile[] {
    const files: TarFile[] = [];
    const seen = new Set<string>();
    let unpacked = 0;
    let offset = 0;
    for (;;) {
        if (offset + BLOCK > archive.length) throw new TarFormatError('truncated archive');
        const block = archive.subarray(offset, offset + BLOCK);
        if (block.every((byte) => byte === 0)) {
            if (!archive.subarray(offset).every((byte) => byte === 0)) {
                throw new TarFormatError('data after the end marker');
            }
            return files;
        }
        if (field(block, 257, 6) !== 'ustar' || field(block, 263, 2) !== '00') {
            throw new TarFormatError('not a ustar header');
        }
        const expected = octalField(block, 148, 8, 'checksum');
        const actual = block.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 0x20 : byte), 0);
        if (expected !== actual) throw new TarFormatError('header checksum mismatch');
        const prefix = field(block, 345, PREFIX_BYTES);
        const name = field(block, 0, NAME_BYTES);
        const path = prefix === '' ? name : `${prefix}/${name}`;
        const type = field(block, 156, 1);
        const size = octalField(block, 124, 12, 'size');
        offset += BLOCK;
        if (seen.size >= TAR_LIMITS.maxEntries) throw new TarFormatError('too many entries');
        if (type === '5') {
            if (!path.endsWith('/') || size !== 0) throw new TarFormatError('malformed directory entry');
            assertSafePath(path.slice(0, -1));
            if (seen.has(path)) throw new TarFormatError(`duplicate path: ${JSON.stringify(path)}`);
            seen.add(path);
            continue;
        }
        if (type !== '0') throw new TarFormatError(`entry type ${JSON.stringify(type)} is not a regular file`);
        assertSafePath(path);
        if (seen.has(path)) throw new TarFormatError(`duplicate path: ${JSON.stringify(path)}`);
        seen.add(path);
        unpacked += size;
        if (unpacked > TAR_LIMITS.maxUnpackedBytes) throw new TarFormatError('archive unpacks too large');
        if (offset + size > archive.length) throw new TarFormatError('truncated file');
        files.push({ path, bytes: new Uint8Array(archive.subarray(offset, offset + size)) });
        offset += Math.ceil(size / BLOCK) * BLOCK;
    }
}

/**
 * Every regular file under `root`, with `/`-separated relative paths. A symlink, socket or device anywhere is an
 * error: the archive holds exactly the bytes the build wrote, never something a link pointed at.
 */
export async function readTree(root: string): Promise<TarFile[]> {
    const files: TarFile[] = [];
    const walk = async (directory: string, relative: string): Promise<void> => {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
            const absolute = join(directory, entry.name);
            const stats = await lstat(absolute);
            if (stats.isSymbolicLink()) throw new TarPathError(`symlink in the bundle: ${JSON.stringify(path)}`);
            if (stats.isDirectory()) {
                await walk(absolute, path);
            } else if (stats.isFile()) {
                assertSafePath(path);
                files.push({ path, bytes: new Uint8Array(await readFile(absolute)) });
            } else {
                throw new TarPathError(`not a regular file: ${JSON.stringify(path)}`);
            }
        }
    };
    await walk(root, '');
    return files.sort((a, b) => compareBytes(a.path, b.path));
}
