import type { Hostname } from '@ptbk/protocol';

import type { AbuseFeed } from '../../domain/abuse/abuse-feed';
import type { Clock } from '../../domain/ports/clock';
import type { Logger } from '../../domain/ports/logger';
import { WebRiskError, type HashSearchResult, type WebRiskApi } from './web-risk-api';
import { canonicalizeUrl, expressionHash, lookupExpressions } from './web-risk-url';
import { WEB_RISK_THREAT_TYPES, type WebRiskStore } from './web-risk-store';

/** A list not updated for this long past its due diff no longer counts as an answer: "not listed" would be stale. */
export const LIST_MAX_OVERDUE_MS = 2 * 60 * 60 * 1000;
/**
 * `hashes.search` calls per run at most ($50 per 1,000, no free tier). Answers are cached as they come, so a burst of
 * new prefix hits is worked off over several runs; past it the run fails, which keeps the alerts as they are.
 */
export const MAX_HASH_SEARCHES_PER_RUN = 50;

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** The cache's word on one full hash under one prefix, as Web Risk's caching rules read it. */
function verdict(result: HashSearchResult | null, fullHash: Uint8Array, at: number): 'listed' | 'clean' | 'unknown' {
    if (result === null) return 'unknown';
    const threat = result.threats.find((candidate) => hex(candidate.hash) === hex(fullHash));
    if (threat !== undefined) return threat.until > at ? 'listed' : 'unknown';
    return result.negativeUntil > at ? 'clean' : 'unknown';
}

/**
 * Google Web Risk through its Update API (I-08). The threat lists live in `store` and are brought up to date at most
 * once per run, when Google's recommended time has come; a hostname is looked up locally by the hashes of its
 * expressions, and only a prefix hit costs a `hashes.search`, which says whether the full hash is listed. Google sees
 * hash prefixes of hits, never the engine hostnames.
 */
export function createWebRiskFeed(deps: {
    readonly api: WebRiskApi;
    readonly store: WebRiskStore;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly maxHashSearches?: number;
}): AbuseFeed {
    const maxSearches = deps.maxHashSearches ?? MAX_HASH_SEARCHES_PER_RUN;
    let refreshed: Promise<void> | null = null;
    let searches = 0;

    async function refresh(signal: AbortSignal): Promise<void> {
        const at = deps.clock.nowMs();
        const versions = await deps.store.versions();
        for (const threatType of WEB_RISK_THREAT_TYPES) {
            const version = versions[threatType];
            if (version !== undefined && version.nextDiffAt > at) continue;
            try {
                const update = await deps.api.computeDiff(threatType, version?.versionToken ?? null, signal);
                // A mismatch drops the list; the next run asks for a reset, at the normal interval.
                if (!(await deps.store.apply(threatType, update, at))) {
                    deps.logger.warn('web-risk.list-mismatch', { list: threatType, kind: update.kind });
                }
            } catch (error) {
                deps.logger.warn('web-risk.diff-failed', {
                    list: threatType,
                    problem: error instanceof Error ? error.name : 'unknown',
                });
            }
        }
        const current = await deps.store.versions();
        for (const threatType of WEB_RISK_THREAT_TYPES) {
            const version = current[threatType];
            if (version === undefined || at > version.nextDiffAt + LIST_MAX_OVERDUE_MS) {
                throw new WebRiskError(`the ${threatType} list is not available`);
            }
        }
    }

    async function search(
        prefixes: readonly Uint8Array[],
        signal: AbortSignal,
    ): Promise<Map<string, HashSearchResult>> {
        const results: { prefix: Uint8Array; result: HashSearchResult }[] = [];
        try {
            for (const prefix of prefixes) {
                if (searches >= maxSearches) throw new WebRiskError('too many prefix hits for one run');
                searches++;
                results.push({ prefix, result: await deps.api.searchHashes(prefix, WEB_RISK_THREAT_TYPES, signal) });
            }
        } finally {
            if (results.length > 0) await deps.store.cacheSearches(results, deps.clock.nowMs());
        }
        return new Map(results.map(({ prefix, result }) => [hex(prefix), result]));
    }

    return {
        name: 'web-risk',
        async listed(hostnames: readonly Hostname[], signal: AbortSignal): Promise<ReadonlySet<Hostname>> {
            refreshed ??= refresh(signal);
            await refreshed;
            const byExpression = new Map<string, Hostname[]>();
            for (const hostname of hostnames) {
                const url = canonicalizeUrl(`http://${hostname}/`);
                if (url === null) continue;
                for (const expression of lookupExpressions(url)) {
                    byExpression.set(expression, [...(byExpression.get(expression) ?? []), hostname]);
                }
            }
            const expressions = [...byExpression.keys()];
            const fullHashes = await Promise.all(expressions.map(expressionHash));
            const hits = await deps.store.prefixHits(fullHashes);
            const candidates = expressions.flatMap((expression, index) =>
                (hits[index] ?? []).map((prefix) => ({
                    expression,
                    fullHash: fullHashes[index] as Uint8Array,
                    prefix,
                })),
            );
            const prefixes = [...new Map(candidates.map(({ prefix }) => [hex(prefix), prefix])).values()];
            const cached = await deps.store.cachedSearches(prefixes);
            const answers = new Map(prefixes.map((prefix, index) => [hex(prefix), cached[index] ?? null]));
            const at = deps.clock.nowMs();
            const unknown = prefixes.filter((prefix) =>
                candidates.some(
                    (candidate) =>
                        hex(candidate.prefix) === hex(prefix) &&
                        verdict(answers.get(hex(prefix)) ?? null, candidate.fullHash, at) === 'unknown',
                ),
            );
            const fresh = await search(unknown, signal);
            const listed = new Set<Hostname>();
            for (const { expression, fullHash, prefix } of candidates) {
                const answer = fresh.get(hex(prefix));
                // A fresh answer is the truth now, however short Google says it may be cached.
                const isListed =
                    answer === undefined
                        ? verdict(answers.get(hex(prefix)) ?? null, fullHash, at) === 'listed'
                        : answer.threats.some((threat) => hex(threat.hash) === hex(fullHash));
                if (isListed) {
                    for (const hostname of byExpression.get(expression) ?? []) listed.add(hostname);
                }
            }
            return listed;
        },
    };
}
