import type { Artifact, ReleaseEntry } from '@ptbk/protocol';
import {
    EngineVersion,
    RELEASE_PAYLOAD_TYPE,
    SignedRelease,
    UiBundleManifest,
    dssePayload,
    parseReleaseEntry,
    verifyArtifact,
} from '@ptbk/protocol';

import { ARCHIVE_MANIFEST_PATH, MIRROR_LAYOUT_V1 } from '../../src/suites/ui-loader/store-layout';
import { readFirstEntry } from './archive';
import type { StagingContext } from './context';
import { ARCHIVE_MAX_BYTES, PAGE_MAX_BYTES } from './context';
import type { SafeParser } from './session';
import { readJson } from './session';
import type { StagingCheckId, StagingResult } from './types';

export interface CheckedRelease {
    readonly version: EngineVersion;
    readonly latest: EngineVersion;
    readonly entry: ReleaseEntry;
    readonly artifact: Artifact;
    readonly manifest: UiBundleManifest;
}

const ID = 'staging.ui.release' satisfies StagingCheckId;
const LatestJson: SafeParser<EngineVersion> = {
    safeParse(input) {
        const version =
            typeof input === 'object' && input !== null ? (input as { version?: unknown }).version : undefined;
        const parsed = EngineVersion.safeParse(version);
        return parsed.success
            ? { success: true, data: parsed.data }
            : { success: false, error: { issues: [{ path: ['version'], message: 'not a version' }] } };
    },
};

type Step<T> = { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'problem'; readonly detail: string };

/**
 * The release store as an engine reads it (release mirror layout v1): `latest.json`, the release record, the `ui`
 * artifact by its SHA-256 and the manifest at the head of the archive. Signatures are the engine's to verify; this
 * only shows that the store serves a consistent release, and which one, for the served-files comparison.
 */
export async function checkUiRelease(
    ctx: StagingContext,
    engineVersion: EngineVersion | null,
): Promise<{ readonly result: StagingResult; readonly release: CheckedRelease | null }> {
    const store = ctx.options.releaseUrl.href;
    const fix = `the release store ${store} does not serve a consistent release: check --release-url; for the platform's store (https://ui.ptbk.link/) tell the platform team`;
    const fail = (detail: string) => ({
        result: { id: ID, status: 'fail', detail, fix } satisfies StagingResult,
        release: null,
    });

    const latestRead = readJson(
        MIRROR_LAYOUT_V1.latest,
        await ctx.storeGet(MIRROR_LAYOUT_V1.latest, PAGE_MAX_BYTES),
        LatestJson,
    );
    if (latestRead.kind === 'problem') return fail(latestRead.detail);
    const latest = latestRead.value;

    const notes: string[] = [];
    let version = engineVersion ?? latest;
    let record = await ctx.storeGet(MIRROR_LAYOUT_V1.release(version), PAGE_MAX_BYTES);
    if (version !== latest && record.kind === 'response' && record.status === 404) {
        notes.push(`the engine reports UI ${version}, which the store does not publish; checked the latest instead`);
        version = latest;
        record = await ctx.storeGet(MIRROR_LAYOUT_V1.release(version), PAGE_MAX_BYTES);
    }
    const signed = readJson(MIRROR_LAYOUT_V1.release(version), record, SignedRelease);
    if (signed.kind === 'problem') return fail(signed.detail);
    const entry = releaseEntry(signed.value, version);
    if (entry.kind === 'problem') return fail(entry.detail);
    const artifact = entry.value.artifacts.find(({ kind }) => kind === 'ui');
    if (artifact === undefined) return fail(`release ${version} has no ui artifact`);

    const manifest = await archiveManifest(ctx, version, artifact, entry.value);
    if (manifest.kind === 'problem') return fail(manifest.detail);

    if (engineVersion === null)
        notes.push('without a session this is the latest release, not necessarily the one the engine serves');
    const which = version === latest ? `UI ${version} (latest)` : `UI ${version} (latest ${latest})`;
    return {
        result: {
            id: ID,
            status: 'pass',
            detail: [
                `${which}: release record, archive SHA-256 and manifest (${String(manifest.value.files.length)} files) agree; signatures are the engine's to verify`,
                ...notes,
            ].join('; '),
        },
        release: { version, latest, entry: entry.value, artifact, manifest: manifest.value },
    };
}

function releaseEntry(signed: SignedRelease, version: EngineVersion): Step<ReleaseEntry> {
    const path = MIRROR_LAYOUT_V1.release(version);
    if (signed.envelope.payloadType !== RELEASE_PAYLOAD_TYPE) {
        return { kind: 'problem', detail: `${path}: payload type is not ${RELEASE_PAYLOAD_TYPE}` };
    }
    const entry = parseReleaseEntry(dssePayload(signed.envelope));
    if (entry === undefined) return { kind: 'problem', detail: `${path}: the payload is not a release entry` };
    if (entry.version !== version) return { kind: 'problem', detail: `${path} is the record of ${entry.version}` };
    return { kind: 'ok', value: entry };
}

async function archiveManifest(
    ctx: StagingContext,
    version: EngineVersion,
    artifact: Artifact,
    entry: ReleaseEntry,
): Promise<Step<UiBundleManifest>> {
    const path = MIRROR_LAYOUT_V1.artifact(version, artifact.name);
    const fetched = await ctx.storeGet(path, ARCHIVE_MAX_BYTES);
    if (fetched.kind === 'failed') return { kind: 'problem', detail: `GET ${path}: ${fetched.reason}` };
    if (fetched.status !== 200) return { kind: 'problem', detail: `GET ${path} answered ${String(fetched.status)}` };
    if ((await verifyArtifact(artifact, fetched.body)).kind !== 'ok') {
        return { kind: 'problem', detail: `${path} does not match the SHA-256 in the release record` };
    }
    const first = readFirstEntry(fetched.body);
    if (first.kind === 'invalid') return { kind: 'problem', detail: `${path}: ${first.reason}` };
    if (first.path !== ARCHIVE_MANIFEST_PATH) {
        return { kind: 'problem', detail: `${path}: the first entry is not ${ARCHIVE_MANIFEST_PATH}` };
    }
    let json: unknown;
    try {
        json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(first.bytes));
    } catch {
        return { kind: 'problem', detail: `${path}: ${ARCHIVE_MANIFEST_PATH} is not JSON` };
    }
    const manifest = UiBundleManifest.safeParse(json);
    if (!manifest.success)
        return { kind: 'problem', detail: `${path}: ${ARCHIVE_MANIFEST_PATH} is not a UiBundleManifest` };
    if (manifest.data.version !== version || manifest.data.commit !== entry.commit) {
        return { kind: 'problem', detail: `${path}: the manifest's version or commit differs from the release record` };
    }
    return { kind: 'ok', value: manifest.data };
}
