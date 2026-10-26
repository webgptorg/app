import { readUiArchive } from '@ptbk/release-tools';

import type { BundleStore, InstalledBundle, StagedBundle } from '../domain/ui/bundle-store';
import { bundleId, withdrawn } from '../domain/ui/bundle-store';

/** In memory, with the same archive reader and limits as the file store; for tests and development. */
export function createMemoryBundleStore(): BundleStore & { stagedCount(): number } {
    const staged = new Map<string, StagedBundle>();
    const installed = new Map<string, ReadonlyMap<string, Uint8Array>>();
    let active: InstalledBundle | undefined;
    let previous: InstalledBundle | undefined;
    let next = 0;

    return {
        active: () => active,
        previous: () => previous,
        stage(archive) {
            try {
                const { manifestBytes, files } = readUiArchive(archive);
                const stagingId = `staging-${String(next++)}`;
                const bundle = { stagingId, manifestBytes, files };
                staged.set(stagingId, bundle);
                return Promise.resolve({ kind: 'staged', bundle });
            } catch (error) {
                return Promise.resolve({
                    kind: 'unpack-failed',
                    reason: error instanceof Error ? error.message : 'unreadable archive',
                });
            }
        },
        activate(stagingId, bundle) {
            const files = staged.get(stagingId);
            if (files === undefined) return Promise.reject(new Error(`no staged bundle ${stagingId}`));
            staged.delete(stagingId);
            const installedBundle: InstalledBundle = { ...bundle, id: bundleId(bundle.version, bundle.sha256) };
            if (previous !== undefined) installed.delete(previous.id);
            installed.set(installedBundle.id, files.files);
            previous = active;
            active = installedBundle;
            return Promise.resolve(installedBundle);
        },
        discard(stagingId) {
            staged.delete(stagingId);
            return Promise.resolve();
        },
        withdraw(isRevoked) {
            const next = withdrawn({ active, previous }, isRevoked);
            for (const bundle of [active, previous]) {
                if (bundle !== undefined && bundle !== next.active && bundle !== next.previous) {
                    installed.delete(bundle.id);
                }
            }
            ({ active, previous } = next);
            return Promise.resolve(active);
        },
        read(bundle, path) {
            const listed = bundle.manifest.files.some((file) => file.path === path);
            return Promise.resolve(listed ? installed.get(bundle.id)?.get(path) : undefined);
        },
        stagedCount: () => staged.size,
    };
}
