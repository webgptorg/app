import type { WebRiskThreatType } from '../adapters/abuse/web-risk-store';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const sorted = (prefixes: Iterable<string>) => [...prefixes].sort();

export interface FakeWebRiskRequest {
    readonly method: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
}

export interface FakeWebRiskServer {
    /** Plain `fetch`, answering Web Risk's REST API at webrisk.googleapis.com. */
    readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
    readonly requests: FakeWebRiskRequest[];
    /** Lists `fullHash` (32 bytes) under `threatType`, with its prefix of `prefixSize` bytes in the list. */
    list(threatType: WebRiskThreatType, fullHash: Uint8Array, prefixSize?: number): void;
    /** Takes `fullHash` and its prefix off every list. */
    delist(fullHash: Uint8Array): void;
    /** A prefix in the list with no listed full hash under it: a local hit that `hashes.search` clears. */
    addPrefix(threatType: WebRiskThreatType, prefix: Uint8Array): void;
    /** Answers instead of the API when it returns a response: an outage, a quota, a malformed body. */
    override: ((method: string, url: URL) => Response | null) | null;
    /** `recommendedNextDiff`, `expireTime` and `negativeExpireTime`, from the server's clock. */
    timing: { nextDiffMs: number | null; positiveMs: number; negativeMs: number };
    /** Sends a wrong checksum for the next `computeDiff` answers of this many calls. */
    corruptChecksums: number;
}

/**
 * Google Web Risk as far as the adapter uses it: `threatLists:computeDiff` with RESET and DIFF answers computed from
 * the version token the client sends, and `hashes:search`. It requires the API key in `X-Goog-Api-Key`.
 */
export function createFakeWebRiskServer(options: {
    readonly apiKey: string;
    readonly nowMs: () => number;
}): FakeWebRiskServer {
    const prefixes = new Map<WebRiskThreatType, Set<string>>();
    const listed = new Map<string, Set<WebRiskThreatType>>();
    const snapshots = new Map<string, readonly string[]>();
    let versions = 0;

    const listOf = (threatType: WebRiskThreatType) => {
        const set = prefixes.get(threatType) ?? new Set<string>();
        prefixes.set(threatType, set);
        return set;
    };

    async function computeDiff(url: URL): Promise<Response> {
        const threatType = url.searchParams.get('threatType') as WebRiskThreatType;
        const current = sorted(listOf(threatType));
        const previous = snapshots.get(url.searchParams.get('versionToken') ?? '');
        const token = base64(new TextEncoder().encode(`${threatType}:${String(++versions)}`));
        snapshots.set(token, current);
        const added = previous === undefined ? current : current.filter((prefix) => !previous.includes(prefix));
        const removals =
            previous === undefined
                ? []
                : previous.flatMap((prefix, index) => (current.includes(prefix) ? [] : [index]));
        const bySize = new Map<number, string[]>();
        for (const prefix of added) bySize.set(prefix.length / 2, [...(bySize.get(prefix.length / 2) ?? []), prefix]);
        const all = Buffer.from(current.join(''), 'hex');
        const checksum = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
        if (server.corruptChecksums > 0) {
            server.corruptChecksums--;
            checksum[0] = (checksum[0] as number) ^ 0xff;
        }
        const { nextDiffMs } = server.timing;
        return Response.json({
            responseType: previous === undefined ? 'RESET' : 'DIFF',
            additions: {
                rawHashes: [...bySize].map(([prefixSize, values]) => ({
                    prefixSize,
                    rawHashes: Buffer.from(values.join(''), 'hex').toString('base64'),
                })),
            },
            ...(removals.length > 0 ? { removals: { rawIndices: { indices: removals } } } : {}),
            newVersionToken: token,
            checksum: { sha256: base64(checksum) },
            ...(nextDiffMs === null
                ? {}
                : { recommendedNextDiff: new Date(options.nowMs() + nextDiffMs).toISOString() }),
        });
    }

    function searchHashes(url: URL): Response {
        const prefix = hex(Buffer.from(url.searchParams.get('hashPrefix') ?? '', 'base64'));
        const types = new Set(url.searchParams.getAll('threatTypes'));
        const now = options.nowMs();
        const threats = [...listed]
            .filter(
                ([hash, threatTypes]) => hash.startsWith(prefix) && [...threatTypes].some((type) => types.has(type)),
            )
            .map(([hash, threatTypes]) => ({
                threatTypes: [...threatTypes],
                hash: Buffer.from(hash, 'hex').toString('base64'),
                expireTime: new Date(now + server.timing.positiveMs).toISOString(),
            }));
        return Response.json({
            ...(threats.length > 0 ? { threats } : {}),
            negativeExpireTime: new Date(now + server.timing.negativeMs).toISOString(),
        });
    }

    const server: FakeWebRiskServer = {
        requests: [],
        override: null,
        timing: { nextDiffMs: 30 * 60 * 1000, positiveMs: 5 * 60 * 1000, negativeMs: 60 * 60 * 1000 },
        corruptChecksums: 0,
        async fetch(input, init) {
            const url = new URL(input);
            const headers = Object.fromEntries(new Headers(init.headers).entries());
            const method = url.pathname.replace(/^\/v1\//, '');
            server.requests.push({ method, url: input, headers });
            const override = server.override?.(method, url) ?? null;
            if (override !== null) return override;
            if (url.origin !== 'https://webrisk.googleapis.com' || init.redirect !== 'error') {
                return new Response('unexpected request', { status: 400 });
            }
            if (headers['x-goog-api-key'] !== options.apiKey) {
                return Response.json(
                    { error: { code: 403, message: 'API key not valid.', status: 'PERMISSION_DENIED' } },
                    { status: 403 },
                );
            }
            if (method === 'threatLists:computeDiff') return computeDiff(url);
            if (method === 'hashes:search') return searchHashes(url);
            return new Response('not found', { status: 404 });
        },
        list(threatType, fullHash, prefixSize = 4) {
            listOf(threatType).add(hex(fullHash.subarray(0, prefixSize)));
            const types = listed.get(hex(fullHash)) ?? new Set();
            listed.set(hex(fullHash), types.add(threatType));
        },
        delist(fullHash) {
            listed.delete(hex(fullHash));
            for (const set of prefixes.values()) {
                for (const prefix of set) if (hex(fullHash).startsWith(prefix)) set.delete(prefix);
            }
        },
        addPrefix(threatType, prefix) {
            listOf(threatType).add(hex(prefix));
        },
    };
    return server;
}
