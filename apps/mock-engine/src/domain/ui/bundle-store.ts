import type { EngineVersion, UiBundleManifest } from '@ptbk/protocol';

/** A bundle that passed every check and can be served. */
export interface InstalledBundle {
    /** `<version>-<first 16 hex of sha256>`: also its directory name in the file store. */
    readonly id: string;
    readonly version: EngineVersion;
    /** SHA-256 of the `ui` artifact (the archive), as the verified release entry pins it. */
    readonly sha256: string;
    /** The release's Rekor log index from its verified provenance. */
    readonly logIndex: number;
    /** The verified manifest: the only list of files that are ever served. */
    readonly manifest: UiBundleManifest;
}

/** An unpacked bundle that is not served yet; `files` were read back from where they will be served from. */
export interface StagedBundle {
    readonly stagingId: string;
    readonly manifestBytes: Uint8Array;
    readonly files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
}

export type StageOutcome =
    | { readonly kind: 'staged'; readonly bundle: StagedBundle }
    /** The archive is not a UI archive the unpacker accepts; nothing of it is kept. */
    | { readonly kind: 'unpack-failed'; readonly reason: string };

/**
 * Installed UI bundles: the active one, the previous one, and at most one staged candidate. Activation is atomic: a
 * reader sees the old bundle or the new one, never a mix.
 */
export interface BundleStore {
    active(): InstalledBundle | undefined;
    previous(): InstalledBundle | undefined;
    stage(archive: Uint8Array, signal: AbortSignal): Promise<StageOutcome>;
    /** Makes a staged bundle active; the active one becomes previous and anything older is deleted. */
    activate(stagingId: string, bundle: Omit<InstalledBundle, 'id'>): Promise<InstalledBundle>;
    /** Deletes a staged bundle that failed verification. */
    discard(stagingId: string): Promise<void>;
    /**
     * Stops serving every installed bundle whose version `isRevoked` names, durably: a revoked active bundle gives way
     * to the previous one unless that is revoked too, and then no bundle is active. A revoked bundle is deleted, never
     * kept as previous, so nothing can bring it back. Returns the active bundle afterwards.
     */
    withdraw(isRevoked: (version: EngineVersion) => boolean): Promise<InstalledBundle | undefined>;
    /** One file of an installed bundle by its manifest path, or `undefined`. */
    read(bundle: InstalledBundle, path: string): Promise<Uint8Array | undefined>;
}

export interface InstalledPair {
    readonly active: InstalledBundle | undefined;
    readonly previous: InstalledBundle | undefined;
}

/** What {@link BundleStore.withdraw} leaves installed; the same rule for every adapter. */
export function withdrawn(installed: InstalledPair, isRevoked: (version: EngineVersion) => boolean): InstalledPair {
    const kept = (bundle: InstalledBundle | undefined) =>
        bundle !== undefined && !isRevoked(bundle.version) ? bundle : undefined;
    const active = kept(installed.active);
    if (active === undefined) return { active: kept(installed.previous), previous: undefined };
    return { active, previous: kept(installed.previous) };
}

/** `<version>-<first 16 hex of sha256>`. */
export function bundleId(version: EngineVersion, sha256: string): string {
    return `${version}-${sha256.slice(0, 16)}`;
}
