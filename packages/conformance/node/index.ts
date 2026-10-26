import type { PlatformSuite } from './harness/platform';
import { REGISTRATION_SUITE } from './suites/registration';

export type { EngineCommand, EngineExit, EngineProcess } from './harness/engine-process';
export { liveEngineGroups } from './harness/engine-process';
export type { LaunchEnv, LaunchVariable } from './harness/launch-env';
export { LAUNCH_VARIABLES } from './harness/launch-env';
export type { LoopbackListener } from './harness/loopback';
export { LOOPBACK_DOMAIN, freeLoopbackPort, listenLoopback } from './harness/loopback';
export type {
    Closable,
    EngineApiEndpoint,
    EngineOptions,
    EngineTargetFactory,
    PlatformCheck,
    PlatformCheckContext,
    PlatformExpectations,
    PlatformSuite,
} from './harness/platform';
export { DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_START_TIMEOUT_MS } from './harness/platform';
export type { RunPlatformOptions } from './harness/run-platform';
export { HARNESS_ENGINE_DOMAIN, runPlatformConformance } from './harness/run-platform';
export type { IssueOptions, IssuedCertificate, TestCa, TestCaOptions } from './pki/test-ca';
export { createTestCa } from './pki/test-ca';
export type {
    DashboardAnswer,
    EngineIdentity,
    FakeDashboard,
    FakeDashboardOptions,
    ReceivedHeartbeat,
    ReceivedRegistration,
    RegisteredEngine,
    RegisteredEngineOptions,
} from './fakes/dashboard';
export {
    EngineExited,
    FAKE_DASHBOARD_HOSTNAME,
    UNREACHABLE_RELAYS,
    WaitTimeout,
    jsonAnswer,
    problemAnswer,
    startFakeDashboard,
    startRegisteredEngine,
    waitWhileRunning,
} from './fakes/dashboard';
export { createMockEngineTargetFactory } from './targets/mock-engine';
export { REGISTRATION_SUITE };

/** Every suite that starts the engine itself and acts as the platform around it, in the order they run. */
export const PLATFORM_SUITES: readonly PlatformSuite[] = [REGISTRATION_SUITE];
