import { z } from 'zod';

import { readCapped } from '../read-capped';
import type { ThreatListUpdate, WebRiskThreatType } from './web-risk-store';

export const WEB_RISK_ORIGIN = 'https://webrisk.googleapis.com';

/**
 * Bounds the local list (Update API constraints): Google sends the entries that matter most within it. 2^20 4-byte
 * prefixes are 4 MiB per list, which a RESET answer carries as about 6 MB of base64.
 */
export const MAX_DATABASE_ENTRIES = 2 ** 20;
const MAX_DIFF_BYTES = 32 * 1024 * 1024;
const MAX_SEARCH_BYTES = 1024 * 1024;

/** A Web Risk answer we cannot use. Messages carry a status or a reason, never a URL, header or key. */
export class WebRiskError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WebRiskError';
    }
}

/** Proto3 JSON writes bytes as base64 and accepts either alphabet, so both are read. */
export function decodeBase64(text: string): Uint8Array | null {
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) return null;
    const standard = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    if (standard.length % 4 === 1) return null;
    const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, '='));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encodeBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

const base64 = z.string().max(MAX_DIFF_BYTES);
const timestamp = z.iso.datetime({ offset: true }).transform((value) => Date.parse(value));

/**
 * The fields of a `computeDiff` answer we read; unknown ones are dropped. Rice-encoded parts are refused: we ask for
 * RAW only, so they would mean the request was not understood.
 */
const computeDiffSchema = z.object({
    responseType: z.enum(['DIFF', 'RESET']),
    additions: z
        .object({
            rawHashes: z
                .array(z.object({ prefixSize: z.int().min(4).max(32), rawHashes: base64 }))
                .max(29)
                .optional(),
            riceHashes: z.never().optional(),
        })
        .optional(),
    removals: z
        .object({
            rawIndices: z
                .object({
                    indices: z
                        .array(z.int().min(0))
                        .max(2 * MAX_DATABASE_ENTRIES)
                        .optional(),
                })
                .optional(),
            riceIndices: z.never().optional(),
        })
        .optional(),
    newVersionToken: z.string().min(1).max(4096),
    checksum: z.object({ sha256: z.string().max(64) }),
    recommendedNextDiff: timestamp.optional(),
});

const searchHashesSchema = z.object({
    threats: z
        .array(
            z.object({
                threatTypes: z.array(z.string().max(64)).min(1).max(16),
                hash: z.string().max(64),
                expireTime: timestamp,
            }),
        )
        .max(1000)
        .optional(),
    negativeExpireTime: timestamp.optional(),
});

/** One `hashes.search` answer: the listed full hashes under a prefix, and until when the rest count as clean. */
export interface HashSearchResult {
    readonly threats: readonly { readonly hash: Uint8Array; readonly until: number }[];
    readonly negativeUntil: number;
}

export interface WebRiskApi {
    /** The next update of one list, from `versionToken`, or a full list without one. */
    computeDiff(
        threatType: WebRiskThreatType,
        versionToken: string | null,
        signal: AbortSignal,
    ): Promise<ThreatListUpdate>;
    /** The full hashes under `prefix` that any of `threatTypes` lists; billed per call, unlike `computeDiff`. */
    searchHashes(
        prefix: Uint8Array,
        threatTypes: readonly WebRiskThreatType[],
        signal: AbortSignal,
    ): Promise<HashSearchResult>;
}

/**
 * Web Risk's REST API over plain `fetch` (I-08). The key goes in `X-Goog-Api-Key`, not in `?key=`, so it is never part
 * of a URL that an error, a log or a trace could carry.
 */
export function createWebRiskApi(deps: {
    readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
    /** `WEB_RISK_API_KEY`, restricted to the Web Risk API. */
    readonly apiKey: string;
    readonly userAgent: string;
    /** When an answer is parsed, for answers without a time of their own. */
    readonly nowMs: () => number;
}): WebRiskApi {
    async function get(
        method: string,
        query: URLSearchParams,
        maxBytes: number,
        signal: AbortSignal,
    ): Promise<unknown> {
        const response = await deps.fetch(`${WEB_RISK_ORIGIN}/v1/${method}?${query.toString()}`, {
            headers: { Accept: 'application/json', 'User-Agent': deps.userAgent, 'X-Goog-Api-Key': deps.apiKey },
            redirect: 'error',
            signal,
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new WebRiskError(`Web Risk ${method} answered ${String(response.status)}`);
        }
        const text = await readCapped(response, maxBytes);
        if (text === null) throw new WebRiskError(`Web Risk ${method} answered too much`);
        try {
            return JSON.parse(text) as unknown;
        } catch {
            throw new WebRiskError(`Web Risk ${method} answered something other than JSON`);
        }
    }

    return {
        async computeDiff(threatType, versionToken, signal) {
            const query = new URLSearchParams({
                threatType,
                'constraints.maxDatabaseEntries': String(MAX_DATABASE_ENTRIES),
                'constraints.supportedCompressions': 'RAW',
            });
            if (versionToken !== null) query.set('versionToken', versionToken);
            const answer = computeDiffSchema.safeParse(
                await get('threatLists:computeDiff', query, MAX_DIFF_BYTES, signal),
            );
            if (!answer.success) throw new WebRiskError('Web Risk computeDiff sent an unexpected shape');
            const { responseType, additions, removals, newVersionToken, checksum, recommendedNextDiff } = answer.data;
            const indices = removals?.rawIndices?.indices ?? [];
            if (responseType === 'RESET' && indices.length > 0) {
                throw new WebRiskError('Web Risk computeDiff sent removals with a reset');
            }
            const sha256 = decodeBase64(checksum.sha256);
            if (sha256?.length !== 32 || decodeBase64(newVersionToken) === null) {
                throw new WebRiskError('Web Risk computeDiff sent an invalid checksum or version');
            }
            const decoded = (additions?.rawHashes ?? []).map(({ prefixSize, rawHashes }) => ({
                prefixSize,
                hashes: decodeBase64(rawHashes),
            }));
            const valid = decoded.filter(
                (entry): entry is { prefixSize: number; hashes: Uint8Array } => entry.hashes !== null,
            );
            if (valid.length !== decoded.length) throw new WebRiskError('Web Risk computeDiff sent invalid hashes');
            return {
                kind: responseType === 'RESET' ? 'reset' : 'diff',
                additions: valid,
                removals: indices,
                checksum: sha256,
                versionToken: newVersionToken,
                nextDiffAt: recommendedNextDiff ?? deps.nowMs(),
            };
        },

        async searchHashes(prefix, threatTypes, signal) {
            const query = new URLSearchParams({ hashPrefix: encodeBase64(prefix) });
            for (const threatType of threatTypes) query.append('threatTypes', threatType);
            const answer = searchHashesSchema.safeParse(await get('hashes:search', query, MAX_SEARCH_BYTES, signal));
            if (!answer.success) throw new WebRiskError('Web Risk hashes.search sent an unexpected shape');
            const threats = (answer.data.threats ?? []).map((threat) => ({
                hash: decodeBase64(threat.hash),
                until: threat.expireTime,
            }));
            const valid = threats.filter(
                (threat): threat is { hash: Uint8Array; until: number } => threat.hash?.length === 32,
            );
            if (valid.length !== threats.length) throw new WebRiskError('Web Risk hashes.search sent an invalid hash');
            return { threats: valid, negativeUntil: answer.data.negativeExpireTime ?? deps.nowMs() };
        },
    };
}
