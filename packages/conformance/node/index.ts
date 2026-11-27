import type { PlatformSuite } from './harness/platform';
import { ENGINE_API_PLATFORM_SUITE } from './suites/engine-api';
import { HEARTBEAT_SUITE } from './suites/heartbeat';
import { MEMBER_ACCESS_SUITE } from './suites/member-access';
import { NOTIFICATIONS_SUITE } from './suites/notifications';
import { OWNER_HANDOFF_SUITE } from './suites/owner-handoff';
import { REGISTRATION_SUITE } from './suites/registration';
import { TUNNEL_SUITE } from './suites/tunnel';
import { UI_LOADER_PLATFORM_SUITE } from './suites/ui-loader';

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
export { DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_QUIET_WINDOW_MS, DEFAULT_START_TIMEOUT_MS } from './harness/platform';
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
export type { TunnelCheckSpec, TunnelSuiteOptions } from './suites/tunnel';
export { TUNNEL_CHECKS, createTunnelSuite } from './suites/tunnel';
export type { TunnelRelay, TunnelRelayOptions } from './tunnel/tunnel-relay';
export { startTunnelRelay } from './tunnel/tunnel-relay';
export type { TunnelTiming } from './tunnel/runtime';
export { CONTRACT_TIMING } from './tunnel/runtime';
export { SessionCommandError, createSessionCommandTargetFactory, parseSessionOutput } from './targets/session-command';
export type { EngineEndpoints, EngineRoute, UiLoaderPlatformSuiteOptions } from './suites/ui-loader';
export { createUiLoaderPlatformSuite } from './suites/ui-loader';
export type { EngineApiPlatformSuiteOptions } from './suites/engine-api';
export { createEngineApiPlatformSuite } from './suites/engine-api';
export type { StagingCheckId, StagingOptions, StagingPorts, StagingReport, StagingResult } from './staging/types';
export { STAGING_CHECK_IDS } from './staging/types';
export { createNodeStagingPorts } from './staging/node-ports';
export { runStagingCheck } from './staging/run-staging';
export {
    ENGINE_API_PLATFORM_SUITE,
    HEARTBEAT_SUITE,
    MEMBER_ACCESS_SUITE,
    NOTIFICATIONS_SUITE,
    OWNER_HANDOFF_SUITE,
    REGISTRATION_SUITE,
    TUNNEL_SUITE,
    UI_LOADER_PLATFORM_SUITE,
};

/**
 * Every suite that starts the engine itself and acts as the platform around it, in the order they run: the engine API
 * against one engine behind the harness's relay, then the suites that act as the platform's peers.
 */
export const PLATFORM_SUITES: readonly PlatformSuite[] = [
    ENGINE_API_PLATFORM_SUITE,
    REGISTRATION_SUITE,
    HEARTBEAT_SUITE,
    MEMBER_ACCESS_SUITE,
    OWNER_HANDOFF_SUITE,
    NOTIFICATIONS_SUITE,
    TUNNEL_SUITE,
    UI_LOADER_PLATFORM_SUITE,
];
