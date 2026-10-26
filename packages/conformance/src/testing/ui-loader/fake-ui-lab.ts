import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import type { SecurityOverview, UiRefusalReason } from '@ptbk/engine-api';
import {
    ENGINE_API_VERSION,
    ENGINE_RESERVED_PATHS,
    ENGINE_UI_CSP,
    SecurityOverview as SecurityOverviewSchema,
} from '@ptbk/engine-api';
import type {
    DsseEnvelope,
    EngineVersion,
    ProvenanceVerifier,
    ReleaseEntry,
    ReleaseVerification,
    RevocationList,
    TrustPolicy,
} from '@ptbk/protocol';
import {
    DsseEnvelope as DsseEnvelopeSchema,
    UiBundleManifest,
    concatBytes,
    decodeBase64Std,
    dsseKeyId,
    dssePayload,
    ed25519PublicKeyToBytes,
    pae,
    parseRevocationList,
    satisfiesEngineApiRange,
    verifyArtifact,
    verifyManifestFiles,
    verifyRelease,
} from '@ptbk/protocol';

import { SECURITY_HEADERS } from '../../suites/ui-loader/bench';
import type {
    EngineSettings,
    FakeReleaseStore,
    StoreFault,
    StoreRequest,
    UiLoaderLab,
} from '../../suites/ui-loader/lab';
import { ARCHIVE_MANIFEST_PATH, MIRROR_LAYOUT_V1 } from '../../suites/ui-loader/store-layout';
import type { ConformanceTarget } from '../../target';
import type { ProvenanceMode } from './sigstore-verifier';
import { createFakeSigstoreVerifier } from './sigstore-verifier';
import { readTarEntries, zstdUnstore } from './untar';

/** One deliberate loader bug each; the self-test proves some ui-loader check catches every one. */
export const UI_LOADER_DEFECTS = [
    'skip-provenance',
    'release-key-optional',
    'ignore-maintainer-threshold',
    'lenient-ed25519',
    'cofactorless-ed25519',
    'raw-payload-signature',
    'lenient-payload',
    'contains-san',
    'lenient-extensions',
    'log-optional',
    'delay-from-published-at',
    'first-seen-in-memory',
    'unchecked-archive-hash',
    'unchecked-manifest-files',
    'lenient-unpacker',
    'ignore-engine-api-range',
    'allow-downgrade',
    'install-without-revocations',
    'revocation-state-in-memory',
    'ignore-revocations',
    'keep-revoked-current',
    'clear-on-failure',
    'ignore-pinned',
    'manual-installs',
    'serve-unlisted',
    'fallback-shadows-reserved',
    'manifest-csp',
    'no-eligible-at',
    'mislabel-refusals',
    'panel-wrong-bundle',
    'never-installs',
    'serve-wrong-bytes',
    'reject-malformed-keys',
] as const;
export type UiLoaderDefect = (typeof UI_LOADER_DEFECTS)[number];

const STORE_URL = new URL('https://store.test/mirror/');
const ENGINE_URL = new URL('https://engine.test/');
const COOKIE = 'ui_session=owner';

interface Installed {
    readonly version: string;
    readonly sha256: string;
    readonly logIndex: number;
    readonly files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
    readonly archiveFiles: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
    readonly csp: string;
}

interface Disk {
    active: Installed | null;
    previous: Installed | null;
    firstSeen: Map<string, number>;
    lastAccepted: number | null;
}

/** `lastUpdateCheck` as the fake keeps it; the panel parses it with the contract's schema. */
interface Check {
    readonly at: string;
    readonly outcome: 'up-to-date' | 'installed' | 'refused' | 'unavailable';
    readonly version: string | null;
    readonly reason: UiRefusalReason | null;
    readonly revocationReason: 'missing' | 'invalid' | 'expired' | 'rolled-back' | null;
    readonly eligibleAt: string | null;
}

const revokes = (list: RevocationList, version: string): boolean =>
    list.revoked.some((revoked) => revoked.version === version);

const emptyDisk = (): Disk => ({ active: null, previous: null, firstSeen: new Map(), lastAccepted: null });

class Unavailable extends Error {}

function createStore(): FakeReleaseStore & { get(path: string): { status: number; bytes: Uint8Array<ArrayBuffer> } } {
    const files = new Map<string, Uint8Array<ArrayBuffer>>();
    const faults = new Map<string, StoreFault>();
    const requests: StoreRequest[] = [];
    return {
        url: STORE_URL,
        put: (path, body) => files.set(path, typeof body === 'string' ? new TextEncoder().encode(body) : body),
        delete: (path) => files.delete(path),
        fault: (path, fault) => (fault === null ? faults.delete(path) : faults.set(path, fault)),
        requests: () => requests,
        get(path) {
            requests.push({ path, atMs: Date.now() });
            const fault = faults.get(path);
            if (fault === 'error') return { status: 503, bytes: new Uint8Array(0) };
            const bytes = files.get(path);
            if (bytes === undefined) return { status: 404, bytes: new Uint8Array(0) };
            if (fault === 'truncate') throw new Unavailable('connection reset');
            return { status: 200, bytes };
        },
    };
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const second = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

/** The cofactorless equation SB = R + kA, which mixed-order R and A fail although strict verification accepts them. */
async function cofactorless(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
    try {
        const { Point } = ed25519;
        const r = Point.fromBytes(signature.slice(0, 32));
        const a = Point.fromBytes(publicKey);
        const s = bytesToNumberLE(signature.slice(32));
        const k =
            bytesToNumberLE(
                new Uint8Array(
                    await crypto.subtle.digest('SHA-512', concatBytes(signature.slice(0, 32), publicKey, message)),
                ),
            ) % Point.Fn.ORDER;
        return Point.BASE.multiplyUnsafe(s).equals(r.add(a.multiplyUnsafe(k)));
    } catch {
        return false;
    }
}

/** Every release-key signature on the envelope, with the bytes its key would have signed. */
async function releaseSignatures(
    envelope: DsseEnvelope,
    policy: TrustPolicy,
): Promise<{ publicKey: Uint8Array; signature: Uint8Array }[]> {
    const found: { publicKey: Uint8Array; signature: Uint8Array }[] = [];
    for (const key of policy.releaseKeys) {
        const publicKey = ed25519PublicKeyToBytes(key.publicKey);
        const id = await dsseKeyId(publicKey);
        for (const signature of envelope.signatures) {
            const sig = decodeBase64Std(signature.sig);
            if (signature.keyid === id && sig.kind === 'ok') found.push({ publicKey, signature: sig.bytes });
        }
    }
    return found;
}

function leniently(release: unknown): ReleaseEntry | null {
    try {
        const envelope = (release as { envelope: { payload: string } }).envelope;
        return JSON.parse(atob(envelope.payload)) as ReleaseEntry;
    } catch {
        return null;
    }
}

const MODES: Partial<Record<UiLoaderDefect, ProvenanceMode>> = {
    'skip-provenance': 'accept-all',
    'contains-san': 'contains-san',
    'lenient-extensions': 'lenient-extensions',
    'log-optional': 'log-optional',
};

/**
 * An engine in one process: the store, the loader on C-06's `verifyRelease` with the fakes' Sigstore verifier, the
 * served bundle and the security panel, with at most one defect. Restarting keeps the "disk" unless asked not to.
 */
export function createFakeUiLab(defect?: UiLoaderDefect): UiLoaderLab & { readonly checks: number } {
    const store = createStore();
    const has = (name: UiLoaderDefect) => defect === name;
    let disk = emptyDisk();
    let settings: EngineSettings | null = null;
    let lastCheck: Check | null = null;
    let checks = 0;

    function report(check: Omit<Check, 'at' | 'eligibleAt'> & { readonly eligibleAt?: string | null }): void {
        lastCheck = { at: second(Date.now()), eligibleAt: null, ...check };
        if (has('no-eligible-at')) lastCheck = { ...lastCheck, eligibleAt: null };
    }

    function json(path: string): unknown {
        const answer = store.get(path);
        if (answer.status === 404 && path === MIRROR_LAYOUT_V1.revocations) return null;
        if (answer.status !== 200) throw new Unavailable(path);
        return JSON.parse(decode(answer.bytes));
    }

    async function check(current: EngineSettings): Promise<void> {
        checks += 1;
        const { update } = current;
        if (update.policy === 'manual' && !has('manual-installs')) return;
        const policy = current.trust.trustPolicy;
        let version: string;
        let release: unknown;
        let revocations: unknown;
        try {
            version =
                update.policy === 'pinned' && !has('ignore-pinned')
                    ? update.version
                    : (json(MIRROR_LAYOUT_V1.latest) as { version: string }).version;
            release = json(MIRROR_LAYOUT_V1.release(version));
            revocations = json(MIRROR_LAYOUT_V1.revocations);
        } catch {
            if (has('clear-on-failure')) disk.active = null;
            report({ outcome: 'unavailable', version: null, reason: null, revocationReason: null });
            return;
        }
        const now = Date.now();
        const payloadKey = (release as { envelope?: { payload?: string } }).envelope?.payload ?? '';
        if (!disk.firstSeen.has(payloadKey)) disk.firstSeen.set(payloadKey, now);
        const entrySeen = leniently(release);
        const delayFromPublished = has('delay-from-published-at') && entrySeen !== null;
        const firstSeenAt = delayFromPublished ? 0 : (disk.firstSeen.get(payloadKey) ?? now);
        const base = createFakeSigstoreVerifier(
            current.trust.trustedRoot,
            defect === undefined ? 'strict' : (MODES[defect] ?? 'strict'),
        );
        const logIndex = { value: 0 };
        const provenance: ProvenanceVerifier = {
            async verifyProvenance(bundle, envelope, expected, signal) {
                const result = await base.verifyProvenance(bundle, envelope, expected, signal);
                if (result.kind === 'verified') logIndex.value = result.logIndex;
                return result.kind === 'verified' && delayFromPublished
                    ? { ...result, trustedTime: new Date(0) }
                    : result;
            },
        };
        let verdict: ReleaseVerification = await verifyRelease(
            {
                release,
                revocations,
                lastAcceptedRevocationIssuedAt: disk.lastAccepted === null ? null : new Date(disk.lastAccepted),
                policy,
                mode: update.policy === 'auto' ? 'auto' : 'manual',
                installedVersion: has('allow-downgrade')
                    ? null
                    : ((disk.active?.version ?? null) as EngineVersion | null),
                firstSeenAt: new Date(firstSeenAt),
            },
            { provenance, clock: { now: () => new Date() } },
        );
        verdict = await applyDefects(verdict, release, policy);
        let revokedActive: string | null = null;
        if ('revocationsIssuedAt' in verdict) {
            disk.lastAccepted = Math.max(disk.lastAccepted ?? 0, verdict.revocationsIssuedAt.getTime());
            const envelope = DsseEnvelopeSchema.safeParse(revocations);
            const list = envelope.success ? parseRevocationList(dssePayload(envelope.data)) : undefined;
            const active = disk.active;
            if (
                list !== undefined &&
                active !== null &&
                revokes(list, active.version) &&
                !has('keep-revoked-current')
            ) {
                revokedActive = active.version;
                const previous = disk.previous;
                disk.active = previous !== null && !revokes(list, previous.version) ? previous : null;
                disk.previous = null;
            }
        }
        const refuse = (reason: UiRefusalReason, extra: Partial<Check> = {}): void => {
            if (has('clear-on-failure')) disk.active = null;
            const report_ = { outcome: 'refused' as const, version, reason, revocationReason: null, ...extra };
            report(
                has('mislabel-refusals') ? { ...report_, reason: 'invalid-entry', revocationReason: null } : report_,
            );
        };
        switch (verdict.kind) {
            case 'ok': {
                if (has('never-installs')) {
                    refuse('manifest');
                    return;
                }
                const outcome = await install(verdict.entry, logIndex.value);
                if (outcome === null) return;
                refuse(outcome);
                return;
            }
            case 'not-newer': {
                const artifact = verdict.entry.artifacts.find((candidate) => candidate.kind === 'ui');
                if (disk.active?.version === verdict.entry.version && disk.active.sha256 === artifact?.sha256) {
                    report({ outcome: 'up-to-date', version, reason: null, revocationReason: null });
                    return;
                }
                refuse('not-newer');
                return;
            }
            case 'revocations-unverifiable':
                refuse('revocations-unverifiable', { revocationReason: verdict.reason });
                return;
            case 'delay-not-elapsed':
                refuse('delay-not-elapsed', { eligibleAt: second(verdict.eligibleAt.getTime() + 999) });
                return;
            case 'revoked':
                refuse('revoked', revokedActive === null ? {} : { version: revokedActive });
                return;
            case 'invalid-entry':
            case 'not-in-log':
            case 'signature-threshold-not-met':
                refuse(verdict.kind);
        }
    }

    async function applyDefects(
        verdict: ReleaseVerification,
        release: unknown,
        policy: TrustPolicy,
    ): Promise<ReleaseVerification> {
        const entry = leniently(release);
        if (entry === null) return verdict;
        const ok: ReleaseVerification = { kind: 'ok', entry, eligibleAt: new Date(), revocationsIssuedAt: new Date(0) };
        const strictlyOk = verdict.kind === 'ok';
        const envelope = DsseEnvelopeSchema.safeParse((release as { envelope: unknown }).envelope);
        if (verdict.kind === 'signature-threshold-not-met') {
            if (has('release-key-optional') && verdict.missing === 'release-key') return ok;
            if (has('ignore-maintainer-threshold') && verdict.missing === 'maintainers') return ok;
            if (envelope.success && (verdict.missing === 'trusted-key' || verdict.missing === 'release-key')) {
                const message = pae(envelope.data.payloadType, dssePayload(envelope.data));
                for (const { publicKey, signature } of await releaseSignatures(envelope.data, policy)) {
                    if (has('lenient-ed25519') && ed25519.verify(signature, message, publicKey, { zip215: true }))
                        return ok;
                    if (
                        has('raw-payload-signature') &&
                        ed25519.verify(signature, dssePayload(envelope.data), publicKey)
                    ) {
                        return ok;
                    }
                }
            }
        }
        if (has('cofactorless-ed25519') && strictlyOk && envelope.success) {
            const message = pae(envelope.data.payloadType, dssePayload(envelope.data));
            const signatures = await releaseSignatures(envelope.data, policy);
            const results = await Promise.all(signatures.map((s) => cofactorless(s.publicKey, message, s.signature)));
            if (!results.some(Boolean)) return { kind: 'signature-threshold-not-met', missing: 'release-key' };
        }
        if (has('lenient-payload') && verdict.kind === 'invalid-entry') return ok;
        if (has('install-without-revocations') && verdict.kind === 'revocations-unverifiable') return ok;
        if (has('ignore-revocations') && verdict.kind === 'revoked') {
            return { ...ok, revocationsIssuedAt: verdict.revocationsIssuedAt };
        }
        return verdict;
    }

    async function install(entry: ReleaseEntry, logIndex: number): Promise<UiRefusalReason | null> {
        const artifact = entry.artifacts.find((candidate) => candidate.kind === 'ui');
        if (artifact === undefined) return 'invalid-entry';
        let archive: Uint8Array<ArrayBuffer>;
        try {
            const answer = store.get(MIRROR_LAYOUT_V1.artifact(entry.version, artifact.name));
            if (answer.status !== 200) throw new Unavailable('artifact');
            archive = answer.bytes;
        } catch {
            if (has('clear-on-failure')) disk.active = null;
            report({ outcome: 'unavailable', version: null, reason: null, revocationReason: null });
            return null;
        }
        if (!has('unchecked-archive-hash') && (await verifyArtifact(artifact, archive)).kind !== 'ok')
            return 'hash-mismatch';
        let entries;
        try {
            entries = readTarEntries(zstdUnstore(archive));
        } catch {
            return 'unpack';
        }
        const unsafe = entries.filter(
            (candidate) =>
                candidate.path.startsWith('/') ||
                candidate.path.split('/').includes('..') ||
                candidate.type === '1' ||
                candidate.type === '2',
        );
        if (unsafe.length > 0 && !has('lenient-unpacker')) return 'unpack';
        const archiveFiles = new Map(
            entries
                .filter((candidate) => candidate.type === '0' && !unsafe.includes(candidate))
                .map((candidate) => [candidate.path, candidate.bytes] as const),
        );
        const manifestBytes = archiveFiles.get(ARCHIVE_MANIFEST_PATH);
        archiveFiles.delete(ARCHIVE_MANIFEST_PATH);
        let manifest: UiBundleManifest;
        try {
            manifest = UiBundleManifest.parse(JSON.parse(decode(manifestBytes ?? new Uint8Array(0))));
        } catch {
            return 'manifest';
        }
        if (manifest.version !== entry.version || manifest.commit !== entry.commit) return 'manifest';
        if (!has('ignore-engine-api-range') && !satisfiesEngineApiRange(manifest.engineApi, ENGINE_API_VERSION)) {
            return 'engine-api';
        }
        if (!has('unchecked-manifest-files') && (await verifyManifestFiles(manifest, archiveFiles)).kind !== 'ok') {
            return 'manifest';
        }
        const listed = new Map(
            manifest.files.flatMap((file) => {
                const bytes = archiveFiles.get(file.path);
                return bytes === undefined ? [] : [[file.path, bytes] as const];
            }),
        );
        if (manifestBytes !== undefined) archiveFiles.set(ARCHIVE_MANIFEST_PATH, manifestBytes);
        disk.previous = disk.active;
        disk.active = {
            version: entry.version,
            sha256: artifact.sha256,
            logIndex,
            files: listed,
            archiveFiles,
            csp: manifest.csp,
        };
        report({ outcome: 'installed', version: entry.version, reason: null, revocationReason: null });
        return null;
    }

    function security(): SecurityOverview {
        const at = second(Date.now());
        const zeros = '0'.repeat(64);
        const active = disk.active;
        return SecurityOverviewSchema.parse({
            engine: { version: '1.0.0', releaseLogIndex: 1, releaseLogEntryUuid: null },
            update: { status: 'none', policy: 'auto', pinnedVersion: null, availableVersion: null, eligibleAt: null },
            ui: {
                version: active?.version ?? '0.0.0',
                bundleSha256: has('panel-wrong-bundle') ? zeros : (active?.sha256 ?? zeros),
                releaseLogIndex: has('panel-wrong-bundle') ? null : (active?.logIndex ?? null),
                releaseLogEntryUuid: null,
                lastUpdateCheck: lastCheck,
            },
            tls: { certificateSha256: zeros, notAfter: at, lastCtCheck: null },
            relays: [],
            hostnames: [
                { hostname: 'engine.test', kind: 'default', certificateStatus: 'valid', claimRegistered: null },
            ],
            lastHeartbeat: null,
            clockSkew: null,
            outboundDestinations: [],
        });
    }

    function respond(status: number, body: BodyInit | null, type: string, csp = ENGINE_UI_CSP): Response {
        const headers = new Headers({ ...SECURITY_HEADERS, 'Content-Type': type });
        headers.set('Content-Security-Policy', csp);
        return new Response(body, { status, headers });
    }

    function handle(request: Request): Response {
        if (request.headers.get('Cookie') !== COOKIE) return respond(401, 'sign in', 'text/plain');
        const url = new URL(request.url);
        if (url.pathname === '/api/v1/security') return respond(200, JSON.stringify(security()), 'application/json');
        const active = disk.active;
        if (active === null) return respond(503, 'The UI is unavailable.', 'text/plain');
        const csp = has('manifest-csp') ? active.csp : ENGINE_UI_CSP;
        const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const file = (has('serve-unlisted') ? active.archiveFiles : active.files).get(path);
        if (file !== undefined) {
            const body = has('serve-wrong-bytes') && path !== 'index.html' ? file.slice(1) : file;
            return respond(200, body, 'application/octet-stream', csp);
        }
        const reserved = ENGINE_RESERVED_PATHS.some((prefix) => url.pathname.startsWith(prefix));
        if (reserved && !has('fallback-shadows-reserved')) return respond(404, 'not found', 'text/plain');
        if ((request.headers.get('Accept') ?? '').includes('text/html')) {
            return respond(200, active.files.get('index.html') ?? null, 'text/html', csp);
        }
        return respond(404, 'not found', 'text/plain', csp);
    }

    const target: ConformanceTarget = {
        baseUrl: ENGINE_URL,
        fetch: (input, init) => Promise.resolve(handle(new Request(input, init))),
        session: (subject) => Promise.resolve(subject.kind === 'owner' ? { cookie: COOKIE } : null),
    };

    return {
        store,
        pollMs: 5,
        get checks() {
            return checks;
        },
        start(next, options) {
            const malformed = next.trust.trustPolicy.releaseKeys.some(({ publicKey }) => {
                const bytes = ed25519PublicKeyToBytes(publicKey);
                try {
                    return ed25519.Point.fromBytes(bytes).isSmallOrder();
                } catch {
                    return true;
                }
            });
            if (has('reject-malformed-keys') && malformed)
                return Promise.reject(new Error('engine exited: bad trust policy'));
            if (options.fresh) disk = emptyDisk();
            if (has('first-seen-in-memory')) disk.firstSeen = new Map();
            if (has('revocation-state-in-memory')) disk.lastAccepted = null;
            settings = next;
            lastCheck = null;
            const current = settings;
            setTimeout(() => {
                void check(current);
            }, 0);
            return Promise.resolve(target);
        },
        logTail: () => '',
        close: () => Promise.resolve(),
    };
}
