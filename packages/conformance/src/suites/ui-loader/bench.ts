import type { SecurityOverview, UiUpdateCheck } from '@ptbk/engine-api';
import { ENGINE_API_ROUTES, ENGINE_UI_CSP } from '@ptbk/engine-api';
import type { TrustPolicy } from '@ptbk/protocol';
import { REVOCATION_MAX_VALIDITY_MS } from '@ptbk/protocol';

import type { BaseCheckContext } from '../../check';
import { CheckFailure, fail, skip } from '../../check';
import type { ConformanceTarget, SessionCredential } from '../../target';
import { EngineApi } from '../engine-api/api';
import type { EngineSettings, UiLoaderLab, UpdatePolicySetting } from './lab';
import type { Bundle, BundleSpec, ReleaseKeys, ReleaseSpec, RevocationSpec } from './releases';
import { ARCHIVE_NAME, buildBundle, createReleaseKeys, signRelease, signRevocations, trustPolicyOf } from './releases';
import type { TestSigstore } from './sigstore/test-sigstore';
import { createTestSigstore } from './sigstore/test-sigstore';
import { MIRROR_LAYOUT_V1 } from './store-layout';

const CHECK_WAIT_MS = 30_000;
const POLL_MS = 200;
const DAY_MS = 24 * 3_600_000;

export type UiStatus = SecurityOverview['ui'];

/** What one update check left behind: the panel's report and the bundle the panel says is active. */
export interface Observation {
    readonly check: UiUpdateCheck;
    readonly ui: UiStatus;
}

export interface Published {
    readonly version: string;
    readonly bundle: Bundle;
    readonly record: string;
}

export interface PublishOptions {
    readonly bundle?: Omit<BundleSpec, 'version'>;
    /** Changes what the release record says; the entry's artifact hash is the bundle's unless overridden. */
    readonly release?: Omit<ReleaseSpec, 'entry'> & { readonly entry?: Partial<ReleaseSpec['entry']> };
    /** What the store serves as the archive, when it should differ from what the entry signs. */
    readonly served?: (archive: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
}

const floorToSecond = (ms: number): number => Math.floor(ms / 1000) * 1000;

/**
 * One suite run against one engine: the run's keys, test Sigstore and trust policy, the versions handed out so far
 * (always increasing, so checks never collide), and what the suite believes is installed. Checks drive the engine
 * through it.
 */
export class Bench {
    readonly lab: UiLoaderLab;
    readonly keys: ReleaseKeys;
    readonly sigstore: TestSigstore;
    readonly policy: TrustPolicy;
    #versions = 0;
    #started = false;
    #target: ConformanceTarget | null = null;
    #owner: SessionCredential | null = null;
    /** The bundle the engine serves, as far as the suite knows; `null` until a baseline installed. */
    active: Published | null = null;
    readonly installed: Published[] = [];

    private constructor(lab: UiLoaderLab, keys: ReleaseKeys, sigstore: TestSigstore) {
        this.lab = lab;
        this.keys = keys;
        this.sigstore = sigstore;
        this.policy = trustPolicyOf({ maintainers: keys.maintainers, releasePublicKeys: [keys.release.publicKey()] });
    }

    static async open(lab: UiLoaderLab): Promise<Bench> {
        const [keys, sigstore] = await Promise.all([createReleaseKeys(), createTestSigstore({ now: new Date() })]);
        return new Bench(lab, keys, sigstore);
    }

    nextVersion(): string {
        this.#versions += 1;
        return `1.0.${String(this.#versions)}`;
    }

    settings(update: UpdatePolicySetting, policy: TrustPolicy = this.policy): EngineSettings {
        return { update, trust: { v: 1, trustPolicy: policy, trustedRoot: this.sigstore.trustedRoot } };
    }

    async publish(version: string, options: PublishOptions = {}): Promise<Published> {
        const bundle = await buildBundle({ version, ...options.bundle });
        const record = await signRelease(
            { keys: this.keys, sigstore: this.sigstore },
            {
                ...options.release,
                entry: { version, archiveSha256: bundle.sha256, publishedAt: new Date(), ...options.release?.entry },
            },
        );
        const store = this.lab.store;
        store.put(MIRROR_LAYOUT_V1.release(version), record);
        store.put(
            MIRROR_LAYOUT_V1.artifact(version, ARCHIVE_NAME),
            options.served === undefined ? bundle.archive : options.served(bundle.archive),
        );
        return { version, bundle, record };
    }

    /** Publishes a valid list issued now (second precision, so it is never older than one accepted before). */
    async revocations(revoked: readonly string[] = [], spec: Partial<RevocationSpec> = {}): Promise<void> {
        const issuedAt = new Date(floorToSecond(Date.now()));
        this.lab.store.put(
            MIRROR_LAYOUT_V1.revocations,
            await signRevocations(this.keys, {
                issuedAt,
                expiresAt: new Date(issuedAt.getTime() + 7 * DAY_MS),
                revoked,
                ...spec,
            }),
        );
    }

    setLatest(version: string): void {
        this.lab.store.put(MIRROR_LAYOUT_V1.latest, JSON.stringify({ version }));
    }

    /** (Re)starts the engine; the first start of a run is always on a fresh data directory. */
    async start(ctx: BaseCheckContext, settings: EngineSettings, fresh = false): Promise<number> {
        const startedAt = Date.now();
        const target = await this.lab.start(settings, { fresh: fresh || !this.#started, signal: ctx.signal });
        if (fresh || !this.#started) {
            this.active = null;
            this.installed.length = 0;
        }
        this.#started = true;
        this.#target = target;
        this.#owner = await target.session({ kind: 'owner' });
        if (this.#owner === null) skip('needs-owner-session');
        return startedAt;
    }

    target(): ConformanceTarget {
        if (this.#target === null) throw new Error('the engine was not started');
        return this.#target;
    }

    async security(ctx: BaseCheckContext): Promise<SecurityOverview> {
        const api = new EngineApi({ target: this.target(), signal: ctx.signal }, this.#owner);
        return api.ok(ENGINE_API_ROUTES.getSecurityOverview);
    }

    /**
     * Waits for the update check the engine runs at startup: the store saw the record (or `latest.json`) fetched
     * after the start, and the panel reports a check that ended no earlier than that.
     */
    async awaitCheck(ctx: BaseCheckContext, startedAt: number, fetched: string): Promise<Observation> {
        const deadline = Date.now() + CHECK_WAIT_MS;
        for (;;) {
            const request = this.lab.store
                .requests()
                .find((candidate) => candidate.path === fetched && candidate.atMs >= startedAt);
            if (request !== undefined) {
                const { ui } = await this.security(ctx);
                const check = ui.lastUpdateCheck;
                if (check !== null && Date.parse(check.at) >= floorToSecond(request.atMs)) return { check, ui };
            }
            if (Date.now() > deadline) {
                fail(
                    `the engine reported no UI update check within ${String(CHECK_WAIT_MS / 1000)} s of starting ` +
                        `(${request === undefined ? `${fetched} was never fetched` : 'lastUpdateCheck did not move'})` +
                        `\n${this.lab.logTail()}`,
                );
            }
            await sleep(this.lab.pollMs ?? POLL_MS, ctx.signal);
        }
    }

    /** Restarts pinned to `version` and returns its startup check. */
    async pinned(ctx: BaseCheckContext, version: string, policy?: TrustPolicy): Promise<Observation> {
        const startedAt = await this.start(ctx, this.settings({ policy: 'pinned', version }, policy));
        return this.awaitCheck(ctx, startedAt, MIRROR_LAYOUT_V1.release(version));
    }

    /** Restarts under `auto` and returns the check of what `latest.json` names. */
    async auto(ctx: BaseCheckContext): Promise<Observation> {
        const startedAt = await this.start(ctx, this.settings({ policy: 'auto' }));
        return this.awaitCheck(ctx, startedAt, MIRROR_LAYOUT_V1.latest);
    }

    /** A valid release, installed; the baseline every refusal is measured against. */
    async install(ctx: BaseCheckContext, options: PublishOptions = {}): Promise<Published> {
        await this.revocations();
        const published = await this.publish(this.nextVersion(), options);
        const seen = await this.pinned(ctx, published.version);
        if (seen.check.outcome !== 'installed' || seen.ui.version !== published.version) {
            throw new CheckFailure(
                `a valid release ${published.version} did not install under pinned: ${describeCheck(seen.check)}`,
            );
        }
        this.active = published;
        this.installed.push(published);
        return published;
    }

    async baseline(ctx: BaseCheckContext): Promise<Published> {
        return this.active ?? this.install(ctx);
    }

    /** A request on the engine's origin as a signed-in browser navigates or loads a subresource. */
    async get(ctx: BaseCheckContext, path: string, accept = '*/*'): Promise<Served> {
        const target = this.target();
        const headers: Record<string, string> = { Accept: accept, 'Sec-Fetch-Site': 'same-origin' };
        if (this.#owner !== null && 'cookie' in this.#owner) headers['Cookie'] = this.#owner.cookie;
        if (this.#owner !== null && 'bearer' in this.#owner) headers['Authorization'] = `Bearer ${this.#owner.bearer}`;
        const response = await target.fetch(new URL(path, target.baseUrl), { headers, signal: ctx.signal });
        return {
            status: response.status,
            headers: response.headers,
            bytes: new Uint8Array(await response.arrayBuffer()),
        };
    }

    /** Which installed version the engine's entry page is, by its marker; `null` when it serves no bundle. */
    async servedVersion(ctx: BaseCheckContext): Promise<string | null> {
        const served = await this.get(ctx, '/', 'text/html');
        const match = /<meta name="ptbk-conformance-ui" content="([^"]+)">/.exec(
            new TextDecoder().decode(served.bytes),
        );
        return served.status === 200 && match?.[1] !== undefined ? match[1] : null;
    }
}

export interface Served {
    readonly status: number;
    readonly headers: Headers;
    readonly bytes: Uint8Array;
}

export function describeCheck(check: UiUpdateCheck): string {
    const parts: string[] = [check.outcome];
    if (check.version !== null) parts.push(check.version);
    if (check.reason !== null) parts.push(check.reason);
    if (check.revocationReason !== null) parts.push(check.revocationReason);
    return parts.join(' ');
}

export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                reject(signal.reason as Error);
            },
            { once: true },
        );
    });
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
    'content-security-policy': ENGINE_UI_CSP,
    'strict-transport-security': 'max-age=31536000',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
});

export const REVOCATION_LIMITS = Object.freeze({ maxValidityMs: REVOCATION_MAX_VALIDITY_MS });
