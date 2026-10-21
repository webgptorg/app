import type { UiRefusalReason, UiRevocationReason } from '@ptbk/engine-api';
import { UiUpdateCheck } from '@ptbk/engine-api';
import type {
    Artifact,
    EngineVersion,
    ProvenanceVerifier,
    ReleaseVerification,
    RevocationsUnverifiableReason,
    TrustPolicy,
} from '@ptbk/protocol';
import {
    RELEASE_PAYLOAD_TYPE,
    SignedRelease,
    UiBundleManifest,
    dssePayload,
    satisfiesEngineApiRange,
    verifyArtifact,
    verifyManifestFiles,
    verifyRelease,
} from '@ptbk/protocol';

import type { Clock } from '../clock';
import type { Logger } from '../logger';
import type { BundleStore, InstalledBundle } from './bundle-store';
import { engineOwnedFiles } from './static-route';
import type { ReleaseSource } from './release-source';
import type { UpdatePolicy } from './update-policy';
import type { UpdateStateStore } from './update-state-store';

/** The largest `ui` artifact the loader downloads; the unpacked bundle has its own cap (200 MB, 10,000 files). */
export const MAX_UI_ARTIFACT_BYTES = 200 * 1024 * 1024;

export type UiUpdateOutcome =
    | { readonly kind: 'up-to-date'; readonly version: EngineVersion }
    | { readonly kind: 'installed'; readonly version: EngineVersion; readonly sha256: string }
    | {
          readonly kind: 'refused';
          /** The version that was asked for: the store's latest or the pinned one, verified or not. */
          readonly version: EngineVersion;
          readonly reason: UiRefusalReason;
          readonly revocationReason?: RevocationsUnverifiableReason;
      }
    | { readonly kind: 'unavailable' };

/**
 * The outcome as the security panel reports it (`ui.lastUpdateCheck`). Refusal reasons are the engine API's own list,
 * so the panel shows exactly what the loader decided.
 */
export function uiUpdateCheckOf(outcome: UiUpdateOutcome, atMs: number): UiUpdateCheck {
    const at = new Date(atMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    if (outcome.kind === 'unavailable') {
        return UiUpdateCheck.parse({ at, outcome: 'unavailable', version: null, reason: null, revocationReason: null });
    }
    const refused = outcome.kind === 'refused' ? outcome : null;
    const revocationReason: UiRevocationReason | null = refused?.revocationReason ?? null;
    return UiUpdateCheck.parse({
        at,
        outcome: outcome.kind,
        version: outcome.version,
        reason: refused?.reason ?? null,
        revocationReason,
    });
}

export interface UiUpdateDeps {
    readonly source: ReleaseSource;
    readonly store: BundleStore;
    readonly state: UpdateStateStore;
    readonly provenance: ProvenanceVerifier;
    readonly trust: TrustPolicy;
    readonly policy: UpdatePolicy;
    /** `ENGINE_API_VERSION` of the API this engine serves. */
    readonly engineApiVersion: string;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly signal: AbortSignal;
}

class Unavailable extends Error {
    readonly step: string;

    constructor(step: string) {
        super(step);
        this.step = step;
    }
}

async function fetching<T>(step: string, fetch: () => Promise<T>): Promise<T> {
    try {
        return await fetch();
    } catch {
        throw new Unavailable(step);
    }
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The key `firstSeenAt` is stored under, or `null` when the record is not even a release envelope. */
async function payloadKey(release: unknown): Promise<string | null> {
    const parsed = SignedRelease.safeParse(release);
    if (!parsed.success || parsed.data.envelope.payloadType !== RELEASE_PAYLOAD_TYPE) return null;
    return sha256Hex(dssePayload(parsed.data.envelope));
}

async function download(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_UI_ARTIFACT_BYTES) {
            await reader.cancel();
            throw new Error('artifact over the size cap');
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

function parseManifest(bytes: Uint8Array): UiBundleManifest | undefined {
    try {
        const parsed = UiBundleManifest.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
}

type Verified = Extract<ReleaseVerification, { readonly kind: 'ok' }>;

/**
 * One update check (ADR 0003; spec, Interfaces 5): fetch the release and the revocation list, decide with C-06's
 * `verifyRelease` alone, then download the `ui` artifact, check its hash, unpack, check every file against the manifest
 * and the manifest's engine API range, and switch atomically. Every refusal leaves the active bundle as it was.
 */
export async function checkForUiUpdate(deps: UiUpdateDeps): Promise<UiUpdateOutcome> {
    const { logger } = deps;
    try {
        return await check(deps);
    } catch (error) {
        if (!(error instanceof Unavailable)) throw error;
        logger.warn('ui.unavailable', { step: error.step });
        return { kind: 'unavailable' };
    }
}

async function check(deps: UiUpdateDeps): Promise<UiUpdateOutcome> {
    const { source, store, state, signal, logger } = deps;
    const version =
        deps.policy.kind === 'pinned' ? deps.policy.version : await fetching('latest', () => source.latest(signal));
    const release = await fetching('release', () => source.release(version, signal));
    const revocations = await fetching('revocations', () => source.revocations(signal));

    const now = new Date(deps.clock.nowMs());
    const key = await payloadKey(release);
    const firstSeenAt = key === null ? now : await state.firstSeenAt(key, now);
    const active = store.active();
    // verifyRelease decides on the provenance but does not return its log index, which the security panel shows.
    const verified: { logIndex: number | null } = { logIndex: null };
    const provenance: ProvenanceVerifier = {
        async verifyProvenance(bundle, envelope, expected, abort) {
            const result = await deps.provenance.verifyProvenance(bundle, envelope, expected, abort);
            if (result.kind === 'verified') verified.logIndex = result.logIndex;
            return result;
        },
    };
    const verdict = await verifyRelease(
        {
            release,
            revocations,
            lastAcceptedRevocationIssuedAt: await state.lastAcceptedRevocationIssuedAt(),
            policy: deps.trust,
            mode: deps.policy.kind === 'auto' ? 'auto' : 'manual',
            installedVersion: active?.version ?? null,
            firstSeenAt,
            signal,
        },
        { provenance, clock: { now: () => new Date(deps.clock.nowMs()) } },
    );
    if ('revocationsIssuedAt' in verdict) await state.acceptRevocations(verdict.revocationsIssuedAt);

    const refuse = (reason: UiRefusalReason, revocationReason?: RevocationsUnverifiableReason): UiUpdateOutcome => {
        logger.warn('ui.refused', {
            version,
            reason,
            ...(revocationReason === undefined ? {} : { revocationReason }),
        });
        return { kind: 'refused', version, reason, ...(revocationReason === undefined ? {} : { revocationReason }) };
    };
    switch (verdict.kind) {
        case 'ok':
            break;
        case 'revocations-unverifiable':
            logger.error('ui.revocations-unverifiable', { version, reason: verdict.reason });
            return refuse('revocations-unverifiable', verdict.reason);
        case 'not-newer':
            if (isActive(active, verdict.entry.version, uiArtifact(verdict.entry.artifacts)?.sha256)) {
                return { kind: 'up-to-date', version: verdict.entry.version };
            }
            return refuse('not-newer');
        case 'invalid-entry':
        case 'signature-threshold-not-met':
        case 'not-in-log':
        case 'revoked':
        case 'delay-not-elapsed':
            return refuse(verdict.kind);
    }
    if (verified.logIndex === null) throw new Error('verifyRelease accepted a release without verified provenance');
    return install(deps, verdict, verified.logIndex, refuse);
}

function uiArtifact(artifacts: readonly Artifact[]): Artifact | undefined {
    return artifacts.find((artifact) => artifact.kind === 'ui');
}

function isActive(active: InstalledBundle | undefined, version: EngineVersion, sha256: string | undefined): boolean {
    return active !== undefined && active.version === version && active.sha256 === sha256;
}

async function install(
    deps: UiUpdateDeps,
    verdict: Verified,
    logIndex: number,
    refuse: (reason: UiRefusalReason) => UiUpdateOutcome,
): Promise<UiUpdateOutcome> {
    const { source, store, signal, logger } = deps;
    const { entry } = verdict;
    // The artifact is found by kind, never by name: the name is not part of the contract (E-01).
    const artifact = uiArtifact(entry.artifacts);
    if (artifact === undefined) return refuse('invalid-entry');
    const archive = await fetching('artifact', async () =>
        download(await source.artifact(entry.version, artifact.name, signal)),
    );
    if ((await verifyArtifact(artifact, archive)).kind !== 'ok') return refuse('hash-mismatch');

    const staged = await store.stage(archive, signal);
    if (staged.kind === 'unpack-failed') {
        logger.warn('ui.unpack-failed', { version: entry.version, reason: staged.reason });
        return refuse('unpack');
    }
    const { bundle } = staged;
    const rejected = await checkBundle(deps, verdict, bundle.manifestBytes, bundle.files);
    if (rejected !== null) {
        await store.discard(bundle.stagingId);
        return refuse(rejected);
    }
    const manifest = parseManifest(bundle.manifestBytes);
    if (manifest === undefined) throw new Error('manifest changed between check and activation');
    const installed = await store.activate(bundle.stagingId, {
        version: entry.version,
        sha256: artifact.sha256,
        logIndex,
        manifest,
    });
    logger.info('ui.installed', { version: installed.version, sha256: installed.sha256, logIndex });
    return { kind: 'installed', version: installed.version, sha256: installed.sha256 };
}

async function checkBundle(
    deps: UiUpdateDeps,
    verdict: Verified,
    manifestBytes: Uint8Array,
    files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
): Promise<'manifest' | 'engine-api' | null> {
    const manifest = parseManifest(manifestBytes);
    if (manifest === undefined) return 'manifest';
    if (manifest.version !== verdict.entry.version || manifest.commit !== verdict.entry.commit) return 'manifest';
    // C-06's path grammar allows `api/…`, `auth/…`, `setup` and `__mock/…`; a bundle may never claim engine paths.
    if (engineOwnedFiles(manifest).length > 0) return 'manifest';
    // The manifest's `csp` is informational and never read: the headers are engine code.
    if (!satisfiesEngineApiRange(manifest.engineApi, deps.engineApiVersion)) return 'engine-api';
    return (await verifyManifestFiles(manifest, files)).kind === 'ok' ? null : 'manifest';
}
