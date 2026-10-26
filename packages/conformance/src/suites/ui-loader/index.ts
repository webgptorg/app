import type { BaseCheckContext, ConformanceSuite } from '../../check';
import { Bench } from './bench';
import { engineApiRange, filesEnforced, hashMismatch, rollbackNotNewer, unsafeEntries } from './checks/bundle';
import type { UiLoaderCheck } from './checks/common';
import { SUITE, toConformanceCheck } from './checks/common';
import { delayTrustedTime, firstSeenPersisted } from './checks/delay';
import { listedFilesOnly, policyHonoured, securityHeaders, unavailableKeepsCurrent } from './checks/operations';
import { exactIdentity, logRequired } from './checks/provenance';
import {
    expiredKeepsCurrent,
    revocationsUnverifiable,
    revokedCurrent,
    revokedRefused,
    rollbackPersisted,
} from './checks/revocations';
import { dssePaeOnly, installPinnedValid, signatureThreshold, strictEd25519, strictPayload } from './checks/signatures';
import type { UiLoaderLab } from './lab';

/** In run order: the install and serving checks first, the ones that leave the engine without a bundle last. */
export const UI_LOADER_CHECKS: readonly UiLoaderCheck[] = [
    installPinnedValid,
    listedFilesOnly,
    securityHeaders,
    strictEd25519,
    signatureThreshold,
    dssePaeOnly,
    strictPayload,
    exactIdentity,
    logRequired,
    hashMismatch,
    filesEnforced,
    unsafeEntries,
    engineApiRange,
    rollbackNotNewer,
    expiredKeepsCurrent,
    revocationsUnverifiable,
    rollbackPersisted,
    revokedRefused,
    unavailableKeepsCurrent,
    delayTrustedTime,
    firstSeenPersisted,
    policyHonoured,
    revokedCurrent,
];

/**
 * The engine's UI loader, checked black-box: the suite runs the engine in a lab, serves it releases from a fake store
 * and reads what it serves and reports. The platform suite (`node/suites/ui-loader`) gives each check a lab of its
 * own; this factory runs every check on one lab, as the in-process self-test does. Without a lab every check skips.
 */
export function createUiLoaderSuite(lab: UiLoaderLab | null): ConformanceSuite {
    const benches = new Map<string, Promise<Bench>>();
    const bench =
        lab === null
            ? null
            : (ctx: BaseCheckContext): Promise<Bench> => {
                  let opened = benches.get(ctx.runId);
                  if (opened === undefined) {
                      opened = Bench.open(lab);
                      benches.set(ctx.runId, opened);
                  }
                  return opened;
              };
    return { id: SUITE, checks: UI_LOADER_CHECKS.map((check) => toConformanceCheck(check, bench)) };
}

export const UI_LOADER_SUITE: ConformanceSuite = createUiLoaderSuite(null);

export type {
    ConformanceTrust,
    EngineSettings,
    FakeReleaseStore,
    StoreFault,
    StoreRequest,
    UiLoaderLab,
    UpdatePolicySetting,
} from './lab';
export { ARCHIVE_MANIFEST_PATH, MIRROR_LAYOUT_V1 } from './store-layout';
