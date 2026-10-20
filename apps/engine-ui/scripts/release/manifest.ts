import { createHash } from 'node:crypto';

import { UiBundleManifest } from '@ptbk/protocol';

import type { TarFile } from './tar.ts';
import { compareBytes } from './tar.ts';

/** The manifest's path inside the archive, and its name next to it. */
export const MANIFEST_PATH = 'manifest.json';

export interface ManifestInput {
    readonly version: string;
    readonly commit: string;
    /** `ENGINE_API_VERSION` the bundle was built against. */
    readonly engineApiVersion: string;
    readonly csp: string;
    /** Every file of `dist/`. */
    readonly files: readonly TarFile[];
}

export class ManifestError extends Error {
    override readonly name = 'ManifestError';
}

/**
 * The engine API versions a bundle supports: the one it was built against up to the next major. Minor versions only
 * add to the contract (ADR 0010), so an older minor may lack something the UI calls.
 */
export function engineApiRange(engineApiVersion: string): string {
    const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(engineApiVersion);
    if (match === null) throw new ManifestError(`not an X.Y.Z engine API version: ${engineApiVersion}`);
    return `>=${engineApiVersion} <${String(Number(match[1]) + 1)}.0.0`;
}

export function sha256Hex(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/** C-06's `UiBundleManifest` for exactly `input.files`, sorted by bytes; throws when the schema refuses it. */
export function buildManifest(input: ManifestInput): UiBundleManifest {
    if (input.files.some(({ path }) => path === MANIFEST_PATH)) {
        throw new ManifestError(`dist/ may not contain ${MANIFEST_PATH}: the archive's manifest takes that path`);
    }
    const candidate = {
        v: 1,
        version: input.version,
        commit: input.commit,
        engineApi: engineApiRange(input.engineApiVersion),
        entry: 'index.html',
        files: [...input.files]
            .sort((a, b) => compareBytes(a.path, b.path))
            .map(({ path, bytes }) => ({ path, sha256: sha256Hex(bytes), size: bytes.length })),
        csp: input.csp,
    };
    const parsed = UiBundleManifest.safeParse(candidate);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
        throw new ManifestError(`manifest refused by UiBundleManifest: ${issues}`);
    }
    return parsed.data;
}

/** The manifest as written, once: the archive and the upload carry these exact bytes. */
export function encodeManifest(manifest: UiBundleManifest): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}
