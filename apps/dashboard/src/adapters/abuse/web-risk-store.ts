import { z } from 'zod';

import type { HashSearchResult } from './web-risk-api';
import {
    EMPTY_HASH_LIST,
    applyHashListUpdate,
    decodeHashList,
    encodeHashList,
    matchingPrefixes,
    type HashListUpdate,
    type HashPrefixList,
} from './web-risk-hash-list';

/** The Update API's lists we keep: what Chrome and other Safe Browsing clients warn about on our domains. */
export const WEB_RISK_THREAT_TYPES = ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'] as const;
export type WebRiskThreatType = (typeof WEB_RISK_THREAT_TYPES)[number];

export interface ThreatListVersion {
    /** Base64, as `computeDiff` sent it; sent back for the next diff. */
    readonly versionToken: string;
    /** `recommendedNextDiff`: no diff is asked for before it. */
    readonly nextDiffAt: number;
    /** When a diff last applied. */
    readonly updatedAt: number;
}

export interface ThreatListUpdate extends HashListUpdate {
    readonly versionToken: string;
    readonly nextDiffAt: number;
}

/**
 * Where the Web Risk adapter keeps its threat lists between runs (I-08): one Durable Object, so a list of megabytes is
 * never sent anywhere; only the hashes to look up and the prefixes they hit cross the RPC boundary.
 */
export interface WebRiskStore {
    versions(): Promise<Readonly<Partial<Record<WebRiskThreatType, ThreatListVersion>>>>;
    /**
     * Applies one `computeDiff` answer. False when it does not fit the list or its checksum: the list is then dropped,
     * so the next diff is a reset.
     */
    apply(threatType: WebRiskThreatType, update: ThreatListUpdate, at: number): Promise<boolean>;
    /** Per full hash (SHA-256), the prefixes in any list that it starts with. */
    prefixHits(fullHashes: readonly Uint8Array[]): Promise<readonly (readonly Uint8Array[])[]>;
    /**
     * `hashes.search` answers kept until they expire, per prefix, null where none is kept. Each call is billed, and an
     * engine's hashes are the same every run, so a false-positive prefix is asked about once per negative cache period.
     */
    cachedSearches(prefixes: readonly Uint8Array[]): Promise<readonly (HashSearchResult | null)[]>;
    /** Keeps these answers, replacing the prefix's previous one, and forgets every answer expired by `at`. */
    cacheSearches(
        results: readonly { readonly prefix: Uint8Array; readonly result: HashSearchResult }[],
        at: number,
    ): Promise<void>;
}

/** The slice of Durable Object storage the store uses; a Map stands in for it in tests and dev. */
export interface WebRiskStorage {
    get(key: string): Promise<unknown>;
    put(entries: Record<string, unknown>): Promise<void>;
    delete(keys: string[]): Promise<number>;
    list(options: { prefix: string }): Promise<Map<string, unknown>>;
}

/** Under the 2 MB a Durable Object value may hold. */
export const CHUNK_BYTES = 1024 * 1024;

const metaSchema = z.strictObject({
    v: z.literal(1),
    versionToken: z.string().min(1).max(4096),
    nextDiffAt: z.number(),
    updatedAt: z.number(),
    chunks: z.int().min(1).max(64),
});
type Meta = z.infer<typeof metaSchema>;

const searchSchema = z.strictObject({
    v: z.literal(1),
    negativeUntil: z.number(),
    threats: z.array(z.strictObject({ hash: z.string().regex(/^[0-9a-f]{64}$/), until: z.number() })).max(1000),
});
type StoredSearch = z.infer<typeof searchSchema>;

const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

const SEARCH_PREFIX = 'search:';
const searchKey = (prefix: Uint8Array) => `${SEARCH_PREFIX}${toHex(prefix)}`;
const expiresAt = (search: StoredSearch) =>
    Math.max(search.negativeUntil, ...search.threats.map((threat) => threat.until));

const metaKey = (threatType: WebRiskThreatType) => `meta:${threatType}`;
const chunkKey = (threatType: WebRiskThreatType, index: number) => `chunk:${threatType}:${String(index)}`;

/** The threat lists over `storage`, decoded once per instance and kept in memory while the object lives. */
export function createWebRiskStore(storage: WebRiskStorage): WebRiskStore {
    const lists = new Map<WebRiskThreatType, { readonly meta: Meta; readonly list: HashPrefixList } | null>();

    async function drop(threatType: WebRiskThreatType, chunks: number): Promise<void> {
        await storage.delete([
            metaKey(threatType),
            ...Array.from({ length: chunks }, (_, i) => chunkKey(threatType, i)),
        ]);
        lists.set(threatType, null);
    }

    async function load(threatType: WebRiskThreatType) {
        const cached = lists.get(threatType);
        if (cached !== undefined) return cached;
        const meta = metaSchema.safeParse(await storage.get(metaKey(threatType)));
        if (!meta.success) {
            lists.set(threatType, null);
            return null;
        }
        const parts: Uint8Array[] = [];
        for (let index = 0; index < meta.data.chunks; index++) {
            const part = await storage.get(chunkKey(threatType, index));
            if (!(part instanceof Uint8Array)) break;
            parts.push(part);
        }
        const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
        let at = 0;
        for (const part of parts) {
            bytes.set(part, at);
            at += part.length;
        }
        const list = parts.length === meta.data.chunks ? decodeHashList(bytes) : null;
        // A list this version cannot read starts over: the next diff is a reset.
        if (list === null) {
            await drop(threatType, meta.data.chunks);
            return null;
        }
        const entry = { meta: meta.data, list };
        lists.set(threatType, entry);
        return entry;
    }

    return {
        async versions() {
            const versions: Partial<Record<WebRiskThreatType, ThreatListVersion>> = {};
            for (const threatType of WEB_RISK_THREAT_TYPES) {
                const entry = await load(threatType);
                if (entry !== null) {
                    const { versionToken, nextDiffAt, updatedAt } = entry.meta;
                    versions[threatType] = { versionToken, nextDiffAt, updatedAt };
                }
            }
            return versions;
        },

        async apply(threatType, update, at) {
            const current = await load(threatType);
            const list = await applyHashListUpdate(current?.list ?? EMPTY_HASH_LIST, update);
            if (list === null) {
                if (current !== null) await drop(threatType, current.meta.chunks);
                return false;
            }
            const bytes = encodeHashList(list);
            const chunks = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
            const meta: Meta = {
                v: 1,
                versionToken: update.versionToken,
                nextDiffAt: update.nextDiffAt,
                updatedAt: at,
                chunks,
            };
            const entries: Record<string, unknown> = { [metaKey(threatType)]: meta };
            for (let index = 0; index < chunks; index++) {
                entries[chunkKey(threatType, index)] = bytes.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
            }
            await storage.put(entries);
            const stale = Array.from({ length: Math.max(0, (current?.meta.chunks ?? 0) - chunks) }, (_, i) =>
                chunkKey(threatType, chunks + i),
            );
            if (stale.length > 0) await storage.delete(stale);
            lists.set(threatType, { meta, list });
            return true;
        },

        async prefixHits(fullHashes) {
            const loaded: HashPrefixList[] = [];
            for (const threatType of WEB_RISK_THREAT_TYPES) {
                const entry = await load(threatType);
                if (entry !== null) loaded.push(entry.list);
            }
            return fullHashes.map((hash) => {
                const hits = new Map<string, Uint8Array>();
                for (const list of loaded) {
                    for (const prefix of matchingPrefixes(list, hash)) hits.set(toHex(prefix), prefix);
                }
                return [...hits.values()];
            });
        },

        async cachedSearches(prefixes) {
            return Promise.all(
                prefixes.map(async (prefix) => {
                    const stored = searchSchema.safeParse(await storage.get(searchKey(prefix)));
                    if (!stored.success) return null;
                    return {
                        negativeUntil: stored.data.negativeUntil,
                        threats: stored.data.threats.map((threat) => ({
                            hash: fromHex(threat.hash),
                            until: threat.until,
                        })),
                    };
                }),
            );
        },

        async cacheSearches(results, at) {
            const expired: string[] = [];
            for (const [key, value] of await storage.list({ prefix: SEARCH_PREFIX })) {
                const stored = searchSchema.safeParse(value);
                if (!stored.success || expiresAt(stored.data) <= at) expired.push(key);
            }
            const entries: Record<string, StoredSearch> = {};
            for (const { prefix, result } of results) {
                entries[searchKey(prefix)] = {
                    v: 1,
                    negativeUntil: result.negativeUntil,
                    threats: result.threats.map((threat) => ({ hash: toHex(threat.hash), until: threat.until })),
                };
            }
            const stale = expired.filter((key) => !(key in entries));
            if (stale.length > 0) await storage.delete(stale);
            if (Object.keys(entries).length > 0) await storage.put(entries);
        },
    };
}

/** Storage in a Map, for tests and local development. */
export function createMemoryWebRiskStorage(): WebRiskStorage & { readonly entries: Map<string, unknown> } {
    const entries = new Map<string, unknown>();
    return {
        entries,
        get: (key) => Promise.resolve(entries.get(key)),
        put(values) {
            for (const [key, value] of Object.entries(values)) entries.set(key, value);
            return Promise.resolve();
        },
        delete(keys) {
            return Promise.resolve(keys.filter((key) => entries.delete(key)).length);
        },
        list({ prefix }) {
            return Promise.resolve(new Map([...entries].filter(([key]) => key.startsWith(prefix))));
        },
    };
}
