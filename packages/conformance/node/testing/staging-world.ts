import { createHash } from 'node:crypto';

import type { EngineId } from '@ptbk/engine-api';
import { ENGINE_UI_CSP, SIGN_IN_PATH } from '@ptbk/engine-api';
import { RELEASE_PAYLOAD_TYPE } from '@ptbk/protocol';

import { writeArchiveTar, zstdStore } from '../../src/suites/ui-loader/archive';
import type { StagingOptions, StagingPorts, TlsProbe } from '../staging/types';

export const ENGINE_ID = 'abcdefghijklmnopqrstuvwxyz' as EngineId;
export const ENGINE_HOST = `${ENGINE_ID}.engines.ptbk.link`;
export const RELAY_HOST = 'relay-fsn.ptbk.link';
export const RELAY_ADDRESS = '178.105.121.188';
export const OWNER_COOKIE = '__Host-ptbk_session=AAAAAAAAAAAAAAAAAAAAAA';
export const NOW_MS = Date.parse('2026-11-11T12:00:00Z');
const COMMIT = 'c'.repeat(40);

const encoder = new TextEncoder();
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export const INDEX_HTML = encoder.encode(
    '<!doctype html><html><head><script type="module" src="/assets/index-AbCdEf12.js"></script><link rel="stylesheet" href="/assets/index-AbCdEf12.css"></head><body></body></html>',
);
export const SCRIPT = encoder.encode('console.log(1);');
export const STYLE = encoder.encode('body{}');

export interface StagingRelease {
    readonly version: string;
    readonly files: Readonly<Record<string, Uint8Array>>;
    readonly manifest: unknown;
    readonly archive: Uint8Array;
    readonly archiveSha256: string;
    readonly record: unknown;
}

/** A release as the store publishes it; the overrides break one part for a reject path. */
export function buildRelease(
    version: string,
    overrides: {
        readonly manifest?: (manifest: Record<string, unknown>) => unknown;
        readonly firstEntry?: string;
        readonly entry?: (entry: Record<string, unknown>) => unknown;
        readonly payloadType?: string;
        /** The manifest entry's bytes as they are, for one that is not JSON. */
        readonly manifestText?: string;
        readonly indexHtml?: string;
        /** Replaces the archive before it is hashed into the record. */
        readonly archive?: Uint8Array;
    } = {},
): StagingRelease {
    const files: Record<string, Uint8Array> = {
        'index.html': overrides.indexHtml === undefined ? INDEX_HTML : encoder.encode(overrides.indexHtml),
        'assets/index-AbCdEf12.js': SCRIPT,
        'assets/index-AbCdEf12.css': STYLE,
    };
    const base = {
        v: 1,
        version,
        commit: COMMIT,
        engineApi: '>=1.0.0 <2.0.0',
        entry: 'index.html',
        files: Object.entries(files).map(([path, bytes]) => ({ path, sha256: sha256(bytes), size: bytes.length })),
        csp: ENGINE_UI_CSP,
    };
    const manifest = overrides.manifest === undefined ? base : overrides.manifest(base);
    const manifestBytes = encoder.encode(overrides.manifestText ?? JSON.stringify(manifest));
    const archive =
        overrides.archive ??
        zstdStore(
            writeArchiveTar([
                { kind: 'file', path: overrides.firstEntry ?? 'manifest.json', bytes: manifestBytes },
                ...Object.entries(files).map(([path, bytes]) => ({ kind: 'file' as const, path, bytes })),
            ]),
        );
    const archiveSha256 = sha256(archive);
    const entryBase = {
        v: 1,
        version,
        gitTag: `ui-v${version}`,
        commit: COMMIT,
        artifacts: [{ name: 'engine-ui.tar.zst', sha256: archiveSha256, kind: 'ui' }],
        kind: 'regular',
        advisory: null,
        publishedAt: '2026-11-01T00:00:00Z',
    };
    const entry = overrides.entry === undefined ? entryBase : overrides.entry(entryBase);
    const record = {
        v: 1,
        envelope: {
            payloadType: overrides.payloadType ?? RELEASE_PAYLOAD_TYPE,
            payload: Buffer.from(JSON.stringify(entry)).toString('base64'),
            signatures: [{ keyid: 'A'.repeat(43), sig: Buffer.alloc(64).toString('base64') }],
        },
        provenance: '{}',
    };
    return { version, files, manifest, archive, archiveSha256, record };
}

export function securityOverview(ui: Record<string, unknown>): unknown {
    return {
        engine: { version: '1.0.0', releaseLogIndex: null },
        update: { status: 'none', policy: 'auto', pinnedVersion: null, availableVersion: null, eligibleAt: null },
        ui: { releaseLogIndex: null, lastUpdateCheck: null, ...ui },
        tls: { certificateSha256: 'a'.repeat(64), notAfter: '2027-02-01T00:00:00Z', lastCtCheck: null },
        relays: [],
        hostnames: [],
        lastHeartbeat: null,
        outboundDestinations: [],
    };
}

export type Route = (request: Request) => Response | undefined;

const html = (body: Uint8Array | string, status = 200, extra: Record<string, string> = {}): Response =>
    new Response(typeof body === 'string' ? body : new Uint8Array(body), {
        status,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': ENGINE_UI_CSP, ...extra },
    });
const json = (value: unknown, status = 200, type = 'application/json'): Response =>
    new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': type, 'Content-Security-Policy': ENGINE_UI_CSP },
    });
const bytes = (body: Uint8Array): Response => new Response(new Uint8Array(body), { status: 200 });

export interface WorldOptions {
    readonly releases?: readonly StagingRelease[];
    readonly latest?: unknown;
    /** What the engine serves when signed in; `null` for no active bundle (503). */
    readonly served?: StagingRelease | null;
    readonly security?: unknown;
    /** Answers checked before the defaults; return `undefined` to fall through. */
    readonly route?: Route;
    readonly tls?: TlsProbe;
    readonly engineAddresses?: readonly string[];
}

export interface World {
    readonly ports: StagingPorts;
    readonly requests: Request[];
}

/** A staging world in memory: DNS, TLS, the engine behind its gateway and the release store, all well-behaved. */
export function createStagingWorld(options: WorldOptions = {}): World {
    const release = buildRelease('0.1.0');
    const releases = options.releases ?? [release];
    const served = options.served === undefined ? release : options.served;
    const requests: Request[] = [];
    const engine = (request: Request, url: URL): Response => {
        const signedIn = request.headers.get('cookie') === OWNER_COOKIE;
        if (url.pathname === SIGN_IN_PATH || url.pathname === '/setup')
            return html('<!doctype html><title>page</title>');
        if (url.pathname.startsWith('/api/v1/')) {
            if (!signedIn)
                return json({ type: 'about:blank', code: 'unauthenticated' }, 401, 'application/problem+json');
            if (url.pathname === '/api/v1/engine') {
                return json({
                    name: 'Staging',
                    engineId: ENGINE_ID,
                    hostname: ENGINE_HOST,
                    dashboardUrl: 'https://app.ptbk.io',
                    mode: 'tunnel',
                    capabilities: [],
                });
            }
            if (url.pathname === '/api/v1/security') {
                return json(
                    options.security ??
                        securityOverview(
                            served === null
                                ? { version: '0.0.0', bundleSha256: '0'.repeat(64) }
                                : { version: served.version, bundleSha256: served.archiveSha256 },
                        ),
                );
            }
            return json({ code: 'not-found' }, 404, 'application/problem+json');
        }
        if (!signedIn) return new Response(null, { status: 303, headers: { Location: SIGN_IN_PATH } });
        if (served === null) return html('<h1>Promptbook engine</h1>', 503);
        const file = served.files[url.pathname === '/' ? 'index.html' : url.pathname.slice(1)];
        return file === undefined ? json({ code: 'not-found' }, 404, 'application/problem+json') : html(file);
    };
    const store = (url: URL): Response => {
        if (url.pathname === '/ui/latest.json') return json(options.latest ?? { version: releases.at(-1)?.version });
        for (const candidate of releases) {
            if (url.pathname === `/release-log/ui-${candidate.version}.json`) return json(candidate.record);
            if (url.pathname === `/ui/${candidate.version}/engine-ui.tar.zst`) return bytes(candidate.archive);
        }
        return new Response('not found', { status: 404 });
    };
    const fetchFn = (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init);
        requests.push(request);
        const url = new URL(request.url);
        const routed = options.route?.(request);
        // `Response.error()` stands for a connection that failed, which Node's fetch reports by rejecting.
        if (routed?.type === 'error') {
            return Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }));
        }
        if (routed !== undefined) return Promise.resolve(routed);
        if (url.hostname === ENGINE_HOST) return Promise.resolve(engine(request, url));
        if (url.hostname === 'ui.ptbk.link') return Promise.resolve(store(url));
        return Promise.reject(new TypeError('fetch failed'));
    };
    return {
        requests,
        ports: {
            lookup: (hostname) =>
                Promise.resolve(
                    hostname === ENGINE_HOST
                        ? { kind: 'resolved', addresses: options.engineAddresses ?? [RELAY_ADDRESS] }
                        : hostname === RELAY_HOST
                          ? { kind: 'resolved', addresses: [RELAY_ADDRESS] }
                          : { kind: 'failed', code: 'ENOTFOUND' },
                ),
            probeTls: () =>
                Promise.resolve(
                    options.tls ?? {
                        kind: 'handshake',
                        authorized: true,
                        authorizationError: null,
                        hostnameMatches: true,
                        issuer: { organization: "Let's Encrypt", commonName: 'E6' },
                        validToMs: Date.parse('2027-02-01T00:00:00Z'),
                    },
                ),
            fetch: fetchFn,
            nowMs: () => NOW_MS,
        },
    };
}

export function stagingOptions(overrides: Partial<StagingOptions> = {}): StagingOptions {
    return {
        engine: new URL(`https://${ENGINE_HOST}`),
        engineId: ENGINE_ID,
        relays: [RELAY_HOST],
        releaseUrl: new URL('https://ui.ptbk.link/'),
        ownerCookie: OWNER_COOKIE,
        timeoutMs: 1000,
        signal: new AbortController().signal,
        ...overrides,
    };
}
