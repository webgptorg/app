import { EngineVersion } from '@ptbk/protocol';
import { z } from 'zod';

import type { ReleaseSource } from '../../domain/ui/release-source';
import { MAX_UI_ARTIFACT_BYTES } from '../../domain/ui/ui-update';

/**
 * The release store's layout as the mock engine reads it (not a contract yet; E-01 open points): X-03 publishes
 * `ui/<version>/<artifact>` and `release-log/ui-<version>.json`; the latest-version hint and the revocation list sit
 * next to them.
 */
export const RELEASE_STORE_PATHS = Object.freeze({
    latest: 'ui/latest.json',
    release: (version: string) => `release-log/ui-${version}.json`,
    revocations: 'release-log/revocations.json',
    artifact: (version: string, name: string) => `ui/${version}/${name}`,
});

export const RELEASE_SOURCE_LIMITS = Object.freeze({
    latestBytes: 1024,
    /** A `SignedRelease`: the envelope plus at most 64 KiB of Sigstore bundle. */
    releaseBytes: 256 * 1024,
    /** Up to 1,000 revoked versions with their reasons. */
    revocationsBytes: 2 * 1024 * 1024,
    artifactBytes: MAX_UI_ARTIFACT_BYTES,
    /** Small JSON documents, per request. */
    timeoutMs: 15_000,
    /** The artifact, from request to the last byte. */
    artifactTimeoutMs: 300_000,
});

const Latest = z.strictObject({ version: EngineVersion });

export class ReleaseSourceError extends Error {
    constructor(reason: string) {
        super(`release store: ${reason}`);
        this.name = 'ReleaseSourceError';
    }
}

export interface HttpReleaseSourceOptions {
    /** `PTBK_UI_RELEASE_URL`: an `https://` URL whose path ends in `/`. */
    readonly baseUrl: string;
    readonly fetch: typeof fetch;
    readonly limits?: Partial<typeof RELEASE_SOURCE_LIMITS>;
}

function capped(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
    let total = 0;
    return body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                total += chunk.byteLength;
                if (total > maxBytes) controller.error(new ReleaseSourceError('response over the size cap'));
                else controller.enqueue(chunk);
            },
        }),
    );
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
    if (response.body === null) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = capped(response.body, maxBytes).getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        length += value.byteLength;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

/**
 * The release store over HTTPS (`fetch` is the proxy-aware one the engine uses for the dashboard), with a timeout and a
 * size cap on every request. JSON is parsed but not validated here: `verifyRelease` parses strictly itself, and only
 * after a trusted signature verified. A missing revocation list (404) is `null`, which the verification refuses.
 */
export function createHttpReleaseSource(options: HttpReleaseSourceOptions): ReleaseSource {
    const limits = { ...RELEASE_SOURCE_LIMITS, ...options.limits };
    const base = new URL(options.baseUrl);
    if (!base.pathname.endsWith('/')) throw new ReleaseSourceError('the base URL must end in /');

    async function get(path: string, signal: AbortSignal, timeoutMs: number, maxBytes: number): Promise<Response> {
        const response = await options.fetch(new URL(path, base), {
            headers: { accept: 'application/json, application/octet-stream' },
            redirect: 'error',
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
        const declared = Number(response.headers.get('content-length') ?? '0');
        if (declared > maxBytes) {
            await response.body?.cancel();
            throw new ReleaseSourceError('response over the size cap');
        }
        return response;
    }

    async function json(path: string, signal: AbortSignal, maxBytes: number, missing?: 'null'): Promise<unknown> {
        const response = await get(path, signal, limits.timeoutMs, maxBytes);
        if (response.status === 404 && missing === 'null') {
            await response.body?.cancel();
            return null;
        }
        if (response.status !== 200) {
            await response.body?.cancel();
            throw new ReleaseSourceError(`status ${String(response.status)}`);
        }
        const bytes = await readCapped(response, maxBytes);
        try {
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch {
            // Undecodable JSON is handed on as such: verifyRelease refuses it as an invalid entry or list.
            return undefined;
        }
    }

    return {
        async latest(signal) {
            const parsed = Latest.safeParse(await json(RELEASE_STORE_PATHS.latest, signal, limits.latestBytes));
            if (!parsed.success) throw new ReleaseSourceError('latest.json is not { version }');
            return parsed.data.version;
        },
        release: (version, signal) => json(RELEASE_STORE_PATHS.release(version), signal, limits.releaseBytes),
        revocations: (signal) => json(RELEASE_STORE_PATHS.revocations, signal, limits.revocationsBytes, 'null'),
        async artifact(version, name, signal) {
            const response = await get(
                RELEASE_STORE_PATHS.artifact(version, encodeURIComponent(name)),
                signal,
                limits.artifactTimeoutMs,
                limits.artifactBytes,
            );
            if (response.status !== 200 || response.body === null) {
                await response.body?.cancel();
                throw new ReleaseSourceError(`status ${String(response.status)}`);
            }
            return capped(response.body, limits.artifactBytes);
        },
    };
}
