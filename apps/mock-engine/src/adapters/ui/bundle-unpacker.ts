import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { readTree, readUiArchive } from '@ptbk/release-tools';

export type UnpackOutcome =
    | {
          readonly kind: 'unpacked';
          readonly manifestBytes: Uint8Array;
          /** Read back from `dir` after writing, so the checks see what will be served. */
          readonly files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
      }
    | { readonly kind: 'refused'; readonly reason: string };

const READ_ONLY_FILE = 0o444;
const READ_ONLY_DIRECTORY = 0o555;
const PRIVATE_DIRECTORY = 0o700;

function inside(root: string, path: string): boolean {
    const rel = relative(resolve(root), resolve(path));
    return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep);
}

/**
 * Unpacks a UI archive (`tar.zst`, manifest first) into the empty directory `dir` with `@ptbk/release-tools`'s
 * reader, which refuses absolute paths, `..`, symbolic and hard links, devices, duplicate paths, more than 10,000
 * entries and more than 200 MB. Every target is checked to stay inside `dir` again before it is written, with `wx`
 * so nothing is ever written through an existing name.
 */
export async function unpackBundle(archive: Uint8Array, dir: string): Promise<UnpackOutcome> {
    let read: ReturnType<typeof readUiArchive>;
    try {
        read = readUiArchive(archive);
    } catch (error) {
        return { kind: 'refused', reason: error instanceof Error ? error.message : 'unreadable archive' };
    }
    for (const [path, bytes] of read.files) {
        const target = join(dir, path);
        if (!inside(dir, target))
            return { kind: 'refused', reason: `path outside the bundle: ${JSON.stringify(path)}` };
        await mkdir(dirname(target), { recursive: true, mode: PRIVATE_DIRECTORY });
        await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    const files = await readTree(dir);
    return {
        kind: 'unpacked',
        manifestBytes: read.manifestBytes,
        files: new Map(files.map((file) => [file.path, file.bytes])),
    };
}

/** Files 0444 and directories 0555, so the server process cannot change a bundle it serves by accident. */
export async function makeReadOnly(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await makeReadOnly(path);
        else await chmod(path, READ_ONLY_FILE);
    }
    await chmod(dir, READ_ONLY_DIRECTORY);
}

/** Deletes a tree, read-only ones included (a read-only directory's entries cannot be unlinked). */
export async function removeTree(dir: string): Promise<void> {
    try {
        await chmod(dir, PRIVATE_DIRECTORY);
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) await removeTree(join(dir, entry.name));
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rm(dir, { recursive: true, force: true });
}
