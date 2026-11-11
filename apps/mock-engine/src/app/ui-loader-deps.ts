import { readFile } from 'node:fs/promises';

import type { ProvenanceVerifier } from '@ptbk/protocol';
import { CONFORMANCE_TRUST_FILE_ENV, ConformanceTrustFile, TrustPolicy, isStagingPolicy } from '@ptbk/protocol';
import { PINNED_TRUSTED_ROOT, checkTrustedRoot, createSigstoreProvenanceVerifier } from '@ptbk/release-tools';

import { openFsBundleStore } from '../adapters/ui/fs-bundle-store';
import { openFsUpdateStateStore } from '../adapters/ui/fs-update-state-store';
import { createHttpReleaseSource } from '../adapters/ui/http-release-source';
import { createTestProvenanceVerifier } from '../adapters/ui/test-provenance';
import type { Logger } from '../domain/logger';
import type { UiLoaderDeps } from '../domain/ui/ui-loader';
import type { UiLoaderConfig, UiTrustConfig } from './config';

const TRUST_POLICY_SETTING = 'PTBK_UI_TRUST_POLICY_FILE';
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_TRUSTED_ROOT_BYTES = 1024 * 1024;
const MAX_CONFORMANCE_TRUST_BYTES = MAX_POLICY_BYTES + MAX_TRUSTED_ROOT_BYTES;

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

/**
 * Reads `PTBK_UI_TRUST_POLICY_FILE`. A staging policy shortens the release delay, so a production engine refuses to
 * start with one rather than install releases early.
 */
export async function readTrustPolicy(
    path: string,
    options: { readonly stagingAllowed: boolean },
): Promise<TrustPolicy> {
    const bytes = await readBounded(path, MAX_POLICY_BYTES, TRUST_POLICY_SETTING);
    let policy: TrustPolicy;
    try {
        policy = TrustPolicy.parse(JSON.parse(bytes.toString('utf8')));
    } catch {
        throw new UiLoaderSetupError(`${TRUST_POLICY_SETTING}: ${path} is not a valid TrustPolicy`);
    }
    if (isStagingPolicy(policy) && !options.stagingAllowed) {
        throw new UiLoaderSetupError(
            `${TRUST_POLICY_SETTING}: ${path} is a staging trust policy, which must not be used in production`,
        );
    }
    return policy;
}

export interface UiTrust {
    readonly trust: TrustPolicy;
    readonly provenance: ProvenanceVerifier;
}

type FileTrustConfig = Extract<UiTrustConfig, { readonly kind: 'files' }>;

/** The real Sigstore verifier against the pinned root (or `MOCK_UI_TRUSTED_ROOT_FILE`), or test attestations. */
export async function provenanceVerifier(config: FileTrustConfig): Promise<ProvenanceVerifier> {
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

/**
 * The conformance suite's test trust (`PTBK_CONFORMANCE_TRUST_FILE`): its trust policy, and the real Sigstore verifier
 * under its trusted root, so a conformance run exercises the same verifier as production.
 */
export async function readConformanceTrust(path: string): Promise<UiTrust> {
    const bytes = await readBounded(path, MAX_CONFORMANCE_TRUST_BYTES, CONFORMANCE_TRUST_FILE_ENV);
    let file: ConformanceTrustFile;
    try {
        file = ConformanceTrustFile.parse(JSON.parse(bytes.toString('utf8')));
    } catch {
        throw new UiLoaderSetupError(`${CONFORMANCE_TRUST_FILE_ENV}: ${path} is not a valid conformance trust file`);
    }
    const check = checkTrustedRoot(new TextEncoder().encode(JSON.stringify(file.trustedRoot)));
    if (check.kind === 'invalid') {
        throw new UiLoaderSetupError(`${CONFORMANCE_TRUST_FILE_ENV}: ${path} trustedRoot: ${check.reason}`);
    }
    return { trust: file.trustPolicy, provenance: createSigstoreProvenanceVerifier(check.root) };
}

/** Where the loader's trust policy and provenance verifier come from, read once at startup. */
export async function loadUiTrust(config: UiTrustConfig): Promise<UiTrust> {
    switch (config.kind) {
        case 'conformance':
            return readConformanceTrust(config.file);
        case 'files':
            return {
                trust: await readTrustPolicy(config.trustPolicyFile, { stagingAllowed: config.stagingPolicyAllowed }),
                provenance: await provenanceVerifier(config),
            };
    }
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
    if (config.trust.kind === 'conformance') {
        // Says only that test trust is in use: the policy and root are the suite's, and never logged.
        logger.warn('ui.conformance-trust', { enabled: true });
    } else if (config.trust.fakeProvenance) {
        logger.warn('ui.fake-provenance', { enabled: true });
    }
    const { trust, provenance } = await loadUiTrust(config.trust);
    const store = await openFsBundleStore({ dataDir, logger });
    const state = await openFsUpdateStateStore({ dataDir, logger, installed: store.active() !== undefined });
    const source = createHttpReleaseSource({ baseUrl: config.releaseUrl, fetch: options.fetch });
    return { source, store, state, provenance, trust };
}
