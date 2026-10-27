import type { ConformanceSuite } from './check';
import { ENGINE_API_SUITE } from './suites/engine-api';

export type {
    BaseCheckContext,
    CheckContext,
    CheckOutcome,
    ConformanceCheck,
    ConformanceSuite,
    ResourceTracker,
} from './check';
export { CheckFailure, CheckSkip, Findings, PASS, fail, skip } from './check';
export type { ConformanceTarget, MemberPrivateResources, SessionCredential, SessionSubject } from './target';
export type { CheckResult, CheckScope, ConformanceReport, RunChecksOptions, RunConformanceOptions } from './runner';
export { runChecks, runConformance } from './runner';
export type { ReportSummary } from './report';
export { summarize, writeJsonReport, writeJunitReport } from './report';
export { createSeededRandom } from './random';
export type { MockEngineTargetOptions } from './targets/mock-engine';
export { createMockEngineTarget } from './targets/mock-engine';
export type { Observation, Published, PublishOptions, Served, UiStatus } from './suites/ui-loader/bench';
export { Bench } from './suites/ui-loader/bench';
export type { UiLoaderCheck } from './suites/ui-loader/checks/common';
export { SUITE as UI_LOADER_SUITE_ID } from './suites/ui-loader/checks/common';
export type {
    ConformanceTrust,
    EngineSettings,
    FakeReleaseStore,
    StartOptions,
    StoreFault,
    StoreRequest,
    UiLoaderLab,
    UpdatePolicySetting,
} from './suites/ui-loader/lab';
export { ARCHIVE_MANIFEST_PATH, MIRROR_LAYOUT_V1, UI_LOADER_CHECKS, createUiLoaderSuite } from './suites/ui-loader';
export { ENGINE_API_SUITE };

/**
 * Every suite that runs against an engine at a base URL, in the order they run. Suites that start the engine (`tunnel`,
 * `registration`, `ui-loader`) are platform suites (`node/`), which also run these against an engine they start.
 */
export const ALL_SUITES: readonly ConformanceSuite[] = [ENGINE_API_SUITE];
