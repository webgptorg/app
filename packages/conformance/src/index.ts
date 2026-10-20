import type { ConformanceSuite } from './check';
import { ENGINE_API_SUITE } from './suites/engine-api';
import { TUNNEL_SUITE } from './suites/tunnel';
import { UI_LOADER_SUITE } from './suites/ui-loader';

export type { CheckContext, CheckOutcome, ConformanceCheck, ConformanceSuite, ResourceTracker } from './check';
export { CheckFailure, CheckSkip } from './check';
export type { ConformanceTarget, MemberPrivateResources, SessionCredential, SessionSubject } from './target';
export type { CheckResult, ConformanceReport, RunConformanceOptions } from './runner';
export { runConformance } from './runner';
export type { ReportSummary } from './report';
export { summarize, writeJsonReport, writeJunitReport } from './report';
export { createSeededRandom } from './random';
export type { MockEngineTargetOptions } from './targets/mock-engine';
export { createMockEngineTarget } from './targets/mock-engine';
export { ENGINE_API_SUITE, TUNNEL_SUITE, UI_LOADER_SUITE };

/** Every suite, in the order they run. Suites that act as relay or dashboard are registered with skipped checks. */
export const ALL_SUITES: readonly ConformanceSuite[] = [ENGINE_API_SUITE, TUNNEL_SUITE, UI_LOADER_SUITE];
