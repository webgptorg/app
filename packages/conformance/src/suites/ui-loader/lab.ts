import type { ProductionTrustPolicy } from '@ptbk/protocol';

import type { ConformanceTarget } from '../../target';

export type UpdatePolicySetting =
    | { readonly policy: 'auto' }
    | { readonly policy: 'manual' }
    | { readonly policy: 'pinned'; readonly version: string };

/** The conformance trust file (`PTBK_CONFORMANCE_TRUST_FILE`), honoured only by a conformance build of the engine. */
export interface ConformanceTrust {
    readonly v: 1;
    /** Always a production policy: the suite checks that engines wait out the production delays. */
    readonly trustPolicy: ProductionTrustPolicy;
    /** A Sigstore `trusted_root.json`. */
    readonly trustedRoot: unknown;
}

/** What the suite configures on each start: the update policy and the trust the engine verifies releases against. */
export interface EngineSettings {
    readonly update: UpdatePolicySetting;
    readonly trust: ConformanceTrust;
}

export interface StoreRequest {
    /** Relative to the store's URL, without a leading slash. */
    readonly path: string;
    readonly atMs: number;
}

/** How the store answers a path on purpose: `error` with a 503, `truncate` by cutting the body off halfway. */
export type StoreFault = 'error' | 'truncate';

/** The fake release store the engine fetches from (`PTBK_UI_RELEASE_URL`), in the mirror layout v1. */
export interface FakeReleaseStore {
    /** `https://`, with a path ending in `/`. */
    readonly url: URL;
    put(path: string, body: string | Uint8Array<ArrayBuffer>): void;
    delete(path: string): void;
    /** `null` answers the path normally again. */
    fault(path: string, fault: StoreFault | null): void;
    requests(): readonly StoreRequest[];
}

export interface StartOptions {
    /** Starts over on an empty data directory instead of the previous run's. */
    readonly fresh: boolean;
    readonly signal: AbortSignal;
}

/**
 * Where the suite runs the engine: Node-only (processes, an HTTPS listener, files), so it lives in
 * `@ptbk/conformance/node` and the portable suite only sees this port.
 */
export interface UiLoaderLab {
    readonly store: FakeReleaseStore;
    /** How often to poll the engine while waiting for its update check; default 200 ms. */
    readonly pollMs?: number;
    /**
     * Starts the engine, or restarts it, with these settings, and resolves once it answers HTTP, with a target whose
     * sessions are valid for this run of the engine. Rejects when the engine exits or never answers.
     */
    start(settings: EngineSettings, options: StartOptions): Promise<ConformanceTarget>;
    /** The engine's latest log lines, for failure details; never parsed. */
    logTail(): string;
    close(): Promise<void>;
}
