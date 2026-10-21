import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const TARGET_NAME = 'trusted_root.json';

/** `sigstore`'s TUF client caches verified targets under `<cache>/<mirror host>/targets/`; finds the one root there. */
export async function findCachedTrustedRoot(cacheDir: string): Promise<string> {
    const repos = (await readdir(cacheDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    if (repos.length !== 1 || repos[0] === undefined) {
        throw new Error(`expected one TUF repository in ${cacheDir}, found ${String(repos.length)}`);
    }
    return join(cacheDir, repos[0].name, 'targets', TARGET_NAME);
}
