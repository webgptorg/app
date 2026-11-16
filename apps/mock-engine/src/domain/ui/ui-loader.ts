import { ENGINE_API_VERSION } from '@ptbk/engine-api';
import type { EngineVersion, ProvenanceVerifier, TrustPolicy } from '@ptbk/protocol';

import type { Clock } from '../clock';
import type { Logger } from '../logger';
import type { Random } from '../random';
import type { BundleStore, InstalledBundle } from './bundle-store';
import type { ReleaseSource } from './release-source';
import type { UiUpdateOutcome } from './ui-update';
import { checkForUiUpdate } from './ui-update';
import { createUiUpdater } from './ui-updater';
import type { UpdatePolicy } from './update-policy';
import type { UpdateStateStore } from './update-state-store';

export interface UiLoaderDeps {
    readonly source: ReleaseSource;
    readonly store: BundleStore;
    readonly state: UpdateStateStore;
    readonly provenance: ProvenanceVerifier;
    readonly trust: TrustPolicy;
}

export interface UiLoaderOptions {
    readonly updatePolicy: UpdatePolicy;
    readonly checkIntervalS: number;
    readonly deps: UiLoaderDeps;
    readonly clock: Clock;
    readonly logger: Logger;
    /** Jitter for the extra check when a delayed release becomes eligible. */
    readonly random: Random;
    /**
     * Called with the active bundle at start and whenever a check changed it, for the security panel: `undefined` once
     * a revocation withdrew every installed bundle.
     */
    readonly onActive: (bundle: InstalledBundle | undefined) => void;
    /** Called after every check with its outcome and when it ended, for the security panel. */
    readonly onChecked?: (outcome: UiUpdateOutcome, atMs: number) => void;
}

export interface UiLoader {
    readonly store: BundleStore;
    policy(): UpdatePolicy;
    /**
     * Changes the pinned version, as the owner does in the engine's settings (the real engine asks for a fresh passkey
     * assertion first); only under `pinned`, and it never skips any check.
     */
    pin(version: EngineVersion): boolean;
    /** A check now; under `manual`, this is the owner's approval. */
    checkNow(): Promise<UiUpdateOutcome>;
    lastOutcome(): UiUpdateOutcome | null;
    start(): void;
    stop(): Promise<void>;
}

/** The UI loader's composition: the update check with its stores, the schedule, and the policy the owner can change. */
export function createUiLoader(options: UiLoaderOptions): UiLoader {
    const { deps, clock, logger } = options;
    let policy = options.updatePolicy;
    const updater = createUiUpdater({
        clock,
        logger,
        random: options.random,
        intervalMs: options.checkIntervalS * 1000,
        automatic: policy.kind !== 'manual',
        check: async (signal) => {
            const before = deps.store.active();
            const outcome = await checkForUiUpdate({
                ...deps,
                policy,
                engineApiVersion: ENGINE_API_VERSION,
                clock,
                logger,
                signal,
            });
            const active = deps.store.active();
            if (active !== before) options.onActive(active);
            options.onChecked?.(outcome, clock.nowMs());
            return outcome;
        },
    });
    const active = deps.store.active();
    if (active !== undefined) options.onActive(active);
    return {
        store: deps.store,
        policy: () => policy,
        pin(version) {
            if (policy.kind !== 'pinned') return false;
            policy = { kind: 'pinned', version };
            logger.info('ui.pinned', { version });
            return true;
        },
        checkNow: () => updater.checkNow(),
        lastOutcome: () => updater.lastOutcome(),
        start: () => {
            updater.start();
        },
        stop: () => updater.stop(),
    };
}
