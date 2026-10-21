import type { Stats } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const PRIVATE_TO_OWNER = 0o077;

/** A path that must be reachable by its owner only, and how to describe it in a startup error. */
export interface PrivatePath {
    readonly label: string;
    readonly path: string;
    readonly kind: 'directory' | 'file';
}

export function currentUid(): number | null {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

function octal(mode: number): string {
    return (mode & 0o777).toString(8).padStart(4, '0');
}

export async function lstatOrNull(path: string): Promise<Stats | null> {
    try {
        return await lstat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

/**
 * Like OpenSSH with its keys: refuses a path anyone but its owner could read or swap. Messages name paths and modes,
 * never contents. `uid` null skips the owner check (platforms without uids, or files another tool provisions).
 */
export function privacyProblem(stats: Stats, checked: PrivatePath, uid: number | null): string | null {
    const { label, path, kind } = checked;
    const isKind = kind === 'directory' ? stats.isDirectory() : stats.isFile();
    if (!isKind) return `${label} ${path} is not a ${kind} (symbolic links are refused)`;
    if (uid !== null && stats.uid !== uid) {
        return `${label} ${path} is not owned by the current user (uid ${String(uid)})`;
    }
    if ((stats.mode & PRIVATE_TO_OWNER) !== 0) {
        const fixMode = kind === 'directory' ? '700' : '600';
        return `${label} ${path} is accessible by group or others (mode ${octal(stats.mode)}); run chmod ${fixMode} ${path}`;
    }
    return null;
}

/** Creates the directory (0700) if missing, then returns its privacy problem, if any. */
export async function ensurePrivateDirectory(checked: PrivatePath, uid: number | null): Promise<string | null> {
    let stats = await lstatOrNull(checked.path);
    if (stats === null) {
        await mkdir(checked.path, { recursive: true, mode: 0o700 });
        stats = await lstat(checked.path);
    }
    return privacyProblem(stats, checked, uid);
}

/** Writes a new 0600 file and `fsync`s it; false if it already exists (a concurrent writer won). */
export async function writeNewPrivateFile(path: string, content: string): Promise<boolean> {
    let file;
    try {
        file = await open(path, 'wx', 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
    }
    try {
        await file.writeFile(content);
        await file.sync();
    } finally {
        await file.close();
    }
    return true;
}

/** Makes a create, rename or delete in `directory` survive a crash. */
export async function syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

/**
 * Replaces `path` atomically and durably with a new 0600 file: a temporary file, `fsync`, rename, then `fsync` of the
 * directory, so after a crash the path holds either the old content or the new, never a mix or nothing.
 */
export async function replacePrivateFile(path: string, content: string): Promise<void> {
    const temporary = `${path}.${String(process.pid)}.tmp`;
    // A leftover from a crashed write may have any mode; start from nothing.
    await rm(temporary, { force: true });
    if (!(await writeNewPrivateFile(temporary, content))) throw new Error(`${temporary} appeared while writing`);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
}
