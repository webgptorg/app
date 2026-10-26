# I-08. Google Web Risk abuse feed

- **Lane:** I · **Module:** `apps/dashboard` · **Milestone:** M4
- **Depends on:** I-05
- **Status:** done (#112)
- **Spec:** Abuse on our domains; Hosting and stack (Monitoring jobs); Metadata we still see

## Goal

The dashboard's `abuse-feeds` job checks every active engine's default hostname against Google Web Risk and raises `abuse-feed-listed` to the abuse inbox when Google lists one.

## Context

I-05 built the `AbuseFeed` port (`src/domain/abuse/abuse-feed.ts`), the `abuse-feeds` job (batches of up to 500 hostnames, `abuse-feed-listed` tracked per engine, a failing feed leaves the alerts as they are) and the takedown runbook, but no adapter, because the provider was open. Seb picked Google Web Risk on 2026-10-26 (plan, Decisions): it is the commercial Safe Browsing API, and Safe Browsing's verdicts are what Chrome and other browsers show. Search Console and Safe Browsing email alerts stay manual setup steps (runbook).

## Design decision: Update API, not chunked Lookup

Web Risk has two ways to check a URL ([Lookup API](https://cloud.google.com/web-risk/docs/lookup-api), [Update API](https://cloud.google.com/web-risk/docs/update-api)). `uris.search` (Lookup) checks one URI per request, which does not fit a job that checks up to 500 hostnames per batch inside one Cron invocation's subrequest budget, shared with `ct-watch` and `public-face`.

|                           | Chunked `uris.search` across runs                                                                                    | Update API: `computeDiff` lists kept locally, `hashes.search` on prefix hits                                                                                                                                                                                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subrequests per run       | One per engine checked: the fleet size divided by the runs per check period; hourly for 1,000 engines is 250 per run | At most three `computeDiff` (only when due) plus one `hashes.search` per uncached prefix hit, capped at 50; independent of the fleet                                                                                                                                                                                                                                              |
| Freshness                 | Each engine once per check period, hours as the fleet grows                                                          | Lists follow Google's `recommendedNextDiff`; every engine is checked every 15 minutes                                                                                                                                                                                                                                                                                             |
| Cost ([pricing][pricing]) | 100,000 calls a month free, then $0.50 per 1,000: 1,000 engines hourly is about $310 a month, 10,000 about $3,550    | `computeDiff` is free; `hashes.search` is $50 per 1,000 with no free tier, but runs only on a prefix hit and is cached per Google's expiry times. A false-positive hit costs one call per negative-cache period (an hour in Google's example): about $35 a month per 1,000 engines at a 0.1% hit rate. An engine that is really listed costs about $5 a day until it is suspended |
| Quotas ([quotas][quotas]) | `uris.search` 6,000 per minute                                                                                       | `computeDiff` 600 per minute, `hashes.search` 6,000 per minute; a run uses a handful                                                                                                                                                                                                                                                                                              |
| Workers CPU and memory    | Trivial                                                                                                              | Measured at 2^20 prefixes: a reset applies in about 65 ms, a diff in about 140 ms, 3,000 lookups in 2 ms; 4 MiB per list in memory                                                                                                                                                                                                                                                |
| What Google learns        | Every engine hostname, at every check                                                                                | 4-byte hash prefixes of hits only, never a hostname                                                                                                                                                                                                                                                                                                                               |
| Complexity                | Low                                                                                                                  | URL canonicalisation and hashing, diff and checksum handling, a store for the lists                                                                                                                                                                                                                                                                                               |

**Chosen: the Update API.** Freshness and subrequests stay flat as the fleet grows, cost grows only with prefix hits, and Google never receives our engine list; the extra code is pure and tested against Google's published examples. Once a project calls `computeDiff`, Google bills its `uris.search` calls at the `hashes.search` rate, so this adapter never uses the Lookup API.

The lists live in a Durable Object (`WebRiskLists`, one instance named `web-risk`), not D1 or KV: a list is megabytes that is read, updated and checksummed as a whole. D1 rows and Durable Object values hold at most 2 MB, so either way it is chunked; KV would need a namespace that `infra/cloudflare` does not create, while a Durable Object is one `wrangler.jsonc` binding and migration (`v4`). The object keeps the decoded lists in memory while it lives and matches hashes itself, so only hashes and the prefixes they hit cross the RPC boundary.

[pricing]: https://cloud.google.com/web-risk/pricing
[quotas]: https://cloud.google.com/web-risk/quotas

## Scope

- `src/adapters/abuse/web-risk-url.ts`: canonicalisation, host suffix and path prefix expressions and SHA-256 as ["URLs and hashing"](https://cloud.google.com/web-risk/docs/urls-hashing) specifies, tested against every published canonicalisation, expression and hash example.
- `src/adapters/abuse/web-risk-hash-list.ts`: a list as packed, sorted prefixes per length; RESET and DIFF (removals by index in the old sorted order, then additions), the SHA-256 checksum over the sorted concatenation, prefix matching, encoding for storage.
- `src/adapters/abuse/web-risk-api.ts`: `threatLists:computeDiff` (RAW, `maxDatabaseEntries` 2^20) and `hashes:search` over `fetch`, no Google SDK; zod parsing of the fields we read, unknown fields dropped.
- `src/adapters/abuse/web-risk-store.ts` (the `WebRiskStore` port and its logic over a storage slice, with Map storage for tests), `web-risk-lists-object.ts` (the Durable Object), `durable-object-web-risk-store.ts` (its RPC stub).
- `src/adapters/abuse/web-risk-feed.ts`: the `AbuseFeed` adapter. Per run it diffs each list once if due, matches the hostnames' expressions locally, consults the persisted `hashes.search` cache and asks only about unknown prefixes.
- Wiring in `src/app/scheduled.ts` when `WEB_RISK_API_KEY` is set (outside dev a missing key logs `abuse-feed.unconfigured` each run); config parsing of the key; `src/testing/fake-web-risk-server.ts`.
- Docs: dashboard README, runbook, [apply.md](../apply.md) (GCP steps), the stale provider comment in `abuse-feed.ts`.

## Out of scope

- Custom hostnames (the port checks default hostnames, I-05) and paths: a listing of one path under an engine reaches us through Search Console, not here.
- The Lookup API; Rice decoding (we ask for RAW); the `SOCIAL_ENGINEERING_EXTENDED_COVERAGE` list (Google states under 10% false positives: more paid prefix hits, for verdicts browsers do not show).
- Submitting URLs to Google (Submission API); automatic suspension.

## Design notes

- Lists: `MALWARE`, `SOCIAL_ENGINEERING`, `UNWANTED_SOFTWARE`. A list is diffed only when its `recommendedNextDiff` has passed (every run if Google sends none). A checksum mismatch or an update that does not fit drops the list, so the next run asks for a reset without a version token, at the normal interval, as the Update API requires.
- Back-off: one attempt per list per 15-minute run, never a retry within a run, which is beyond the SLA's 1–32 s exponential back-off after errors.
- Fail closed: if any list is missing or more than 2 h past its due diff, the feed throws and the job leaves the alerts as they are (with a single feed the job fails, and the cron-job-failing rule alerts ops after three runs). A failed `hashes.search` fails the run too.
- Caching follows Web Risk's rules: a full hash is listed while its positive entry is unexpired; otherwise the prefix's negative entry clears it until `negativeExpireTime`; otherwise `hashes.search`. Answers are kept in the object and pruned once expired.
- The API key travels in `X-Goog-Api-Key`, never in the URL, so no error, log or trace carries it; error messages carry a method and a status only, and the job logs the error name.
- An engine hostname's expressions are the host and its parent suffixes (from the last five components, never the TLD), each with path `/`: a listing of the engine domain itself lists every engine, with one `hashes.search`.

## Acceptance criteria

- [ ] Canonicalisation, expression and hash tests reproduce every example on Google's "URLs and hashing" page.
- [ ] Diff tests: reset across prefix lengths, removals before additions, checksum mismatch and malformed updates refused.
- [ ] API tests: request shape (RAW, no key in the URL), unknown fields tolerated, and every reject path (non-200, non-JSON, oversized, unknown response type, Rice data, removals with a reset, bad base64, short checksum or hash, bad times) fails with `WebRiskError` without echoing the key.
- [ ] Feed tests against the fake Web Risk server: a listed engine is found; a parent-domain listing lists every engine with one search; a false-positive hit is searched once per negative-cache period; positive expiry and delisting; diffs only when due and from the stored version; a mismatch resets; an outage is tolerated until the lists are overdue; the per-run search budget keeps its answers for the next run; the key never appears in a URL, an error or a log.
- [ ] Workers test: the Durable Object stores a list larger than one value and answers over RPC.
- [ ] Dashboard lint, typecheck and tests with coverage pass (fast check policy, plan "First blocker: CI").
- [ ] **Status** line above set to `done (#<PR>)`.

## Apply (needs credentials)

Tracked in [apply.md](../apply.md): a GCP project with billing, the Web Risk API enabled, an API key restricted to it, `wrangler secret put WEB_RISK_API_KEY` per environment, and one staging run whose `abuse-feeds` job succeeds. That run also confirms that Web Risk accepts the key in `X-Goog-Api-Key`, which Google documents for its APIs in general but the Web Risk pages do not show.

## Risks and open points

- `hashes.search` has no free tier. The per-run cap of 50 bounds a bad day at about $240; if many engines are listed at once, suspend them (runbook) rather than raise the cap.
- `maxDatabaseEntries` 2^20 caps each list at 4 MiB, and Google then sends the entries it ranks highest. If Google's lists outgrow it, raise it together with the response size cap.
- Web Risk's terms: its verdicts must not be redistributed; we use them only internally, for alerts to the abuse inbox.
