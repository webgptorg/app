import { readFile } from 'node:fs/promises';

import type { ProvenanceVerifier } from '@ptbk/protocol';
import { TrustPolicy } from '@ptbk/protocol';
import { PINNED_TRUSTED_ROOT, checkTrustedRoot, createSigstoreProvenanceVerifier } from '@ptbk/release-tools';

import { openFsBundleStore } from '../adapters/ui/fs-bundle-store';
import { openFsUpdateStateStore } from '../adapters/ui/fs-update-state-store';
import { createHttpReleaseSource } from '../adapters/ui/http-release-source';
import { createTestProvenanceVerifier } from '../adapters/ui/test-provenance';
import type { Logger } from '../domain/logger';
import type { UiLoaderDeps } from '../domain/ui/ui-loader';
import type { UiLoaderConfig } from './config';

const MAX_POLICY_BYTES = 64 * 1024;
const MAX_TRUSTED_ROOT_BYTES = 1024 * 1024;

/** A trust policy or trusted root that cannot be used. Messages name the setting and path, never contents. */
export class UiLoaderSetupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UiLoaderSetupError';
    }
}

async function readBounded(path: string, maxBytes: number, setting: string): Promise<Buffer> {
    let bytes: Buffer;
    try {
        bytes = await readFile(path);
    } catch {
        throw new UiLoaderSetupError(`${setting}: cannot read ${path}`);
    }
    if (bytes.length > maxBytes) throw new UiLoaderSetupError(`${setting}: ${path} is too large`);
    return bytes;
}

export async function readTrustPolicy(path: string): Promise<TrustPolicy> {
    const bytes = await readBounded(path, MAX_POLICY_BYTES, 'MOCK_UI_TRUST_POLICY_FILE');
    try {
        return TrustPolicy.parse(JSON.parse(bytes.toString('utf8')));
    } catch {
        throw new UiLoaderSetupError(`MOCK_UI_TRUST_POLICY_FILE: ${path} is not a valid TrustPolicy`);
    }
}

/** The real Sigstore verifier against the pinned root (or `MOCK_UI_TRUSTED_ROOT_FILE`), or test attestations. */
export async function provenanceVerifier(config: UiLoaderConfig): Promise<ProvenanceVerifier> {
    if (config.fakeProvenance) return createTestProvenanceVerifier();
    if (config.trustedRootFile === null) return createSigstoreProvenanceVerifier(PINNED_TRUSTED_ROOT);
    const check = checkTrustedRoot(
        await readBounded(config.trustedRootFile, MAX_TRUSTED_ROOT_BYTES, 'MOCK_UI_TRUSTED_ROOT_FILE'),
    );
    if (check.kind === 'invalid') {
        throw new UiLoaderSetupError(`MOCK_UI_TRUSTED_ROOT_FILE: ${config.trustedRootFile} ${check.reason}`);
    }
    return createSigstoreProvenanceVerifier(check.root);
}

export interface UiLoaderAdapterOptions {
    readonly config: UiLoaderConfig;
    readonly dataDir: string;
    /** The engine's proxy-aware HTTPS fetch, the same as for the dashboard. */
    readonly fetch: typeof fetch;
    readonly logger: Logger;
}

/** The UI loader's production adapters: the release store over HTTPS and the file stores under `PTBK_DATA_DIR/ui`. */
export async function createUiLoaderDeps(options: UiLoaderAdapterOptions): Promise<UiLoaderDeps> {
    const { config, dataDir, logger } = options;
    if (config.fakeProvenance) logger.warn('ui.fake-provenance', { enabled: true });
    const trust = await readTrustPolicy(config.trustPolicyFile);
    const provenance = await provenanceVerifier(config);
    const store = await openFsBundleStore({ dataDir, logger });
    const state = await openFsUpdateStateStore({ dataDir, logger, installed: store.active() !== undefined });
    const source = createHttpReleaseSource({ baseUrl: config.releaseUrl, fetch: options.fetch });
    return { source, store, state, provenance, trust };
}
