import type { Hostname } from '@ptbk/protocol';

import type { BaseCheckContext, ConformanceCheck, ConformanceSuite, ConformanceTarget } from '../../src/index';
import type { TestCa } from '../pki/test-ca';
import type { EngineProcess } from './engine-process';
import type { LaunchEnv } from './launch-env';

/** What the run expects of the engine; checks derive their waits and timeouts from it. */
export interface PlatformExpectations {
    /** The heartbeat interval the engine was started with: 60 s unless `--heartbeat-interval-s` overrides it. */
    readonly heartbeatIntervalMs: number;
    /**
     * True when the run told the engine to use another interval than the production one. The cadence check then
     * skips, so only a run at the default proves the production cadence.
     */
    readonly intervalOverridden: boolean;
    /** How long an engine may take from spawn to its first request to the platform. */
    readonly startTimeoutMs: number;
    /** How long a check watches for something that must not happen, such as a retry loop or a heartbeat. */
    readonly quietWindowMs: number;
}

/** The interval heartbeat.md fixes; a run that expects another one cannot pass the cadence check. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
export const DEFAULT_START_TIMEOUT_MS = 30_000;
export const DEFAULT_QUIET_WINDOW_MS = 8000;

/** Anything a check starts that must be shut down when the check ends: a fake server, a relay, a store. */
export interface Closable {
    close(): Promise<void>;
}

export interface EngineOptions {
    /** Launch-contract variables, merged over the harness's own (`PTBK_DATA_DIR`, `PTBK_MODE`, …). */
    readonly env?: LaunchEnv;
    /** Default: a fresh path that does not exist yet, inside a private temporary directory. */
    readonly dataDir?: string;
}

/** How the engine API of an engine the harness started is reached, once a relay routes it (C-09). */
export interface EngineApiEndpoint {
    readonly baseUrl: URL;
    /** A fetch that reaches the engine's hostname through the relay and trusts the engine's certificate. */
    readonly fetch: typeof fetch;
}

/**
 * Engine-specific access to the engine API: how a session is obtained is the engine's own business (the open
 * "conformance sessions" point, ENG-99). The mock engine's factory turns on its dev-only control listener per engine.
 */
export interface EngineTargetFactory {
    /** Engine-specific variables for each new engine, decided before it is spawned and kept across restarts. */
    engineEnv(): Promise<Readonly<Record<string, string>>>;
    /** A target for that engine. `session()` asks the engine each time, so it works again after a restart. */
    target(engine: EngineProcess, endpoint: EngineApiEndpoint): ConformanceTarget;
    /**
     * The CA (PEM) the engine's own TLS certificates chain to in a conformance run, if the factory knows it (the
     * mock: its dev CA). Without it, checks that reach the engine through a relay verify only name and dates.
     */
    certificateAuthority?(engine: EngineProcess): Promise<string | null>;
}

/** Everything a platform check gets. Resources it obtains through it are released after the check, newest first. */
export interface PlatformCheckContext extends BaseCheckContext {
    /** The run's CA; the engine trusts it through `NODE_EXTRA_CA_CERTS`. Name-constrained to `localhost`. */
    readonly ca: TestCa;
    /** The engine domain the engine is started with (`PTBK_ENGINE_DOMAIN`). */
    readonly engineDomain: Hostname;
    readonly expectations: PlatformExpectations;
    /** A new private (0700) directory, removed after the check. */
    tempDir(label: string): Promise<string>;
    /** A new engine, not started yet, with a fresh empty data directory unless one is given; stopped after the check. */
    engine(options?: EngineOptions): Promise<EngineProcess>;
    /** Registers a fake server or other fixture for teardown and returns it. */
    use<T extends Closable>(fixture: T): T;
    /** The engine API of an engine, or null when the run has no way to get sessions for it. */
    engineTarget(engine: EngineProcess, endpoint: EngineApiEndpoint): ConformanceTarget | null;
    /** The trust anchor of the engine's own certificates, from the target factory; null when unknown. */
    engineCertificateAuthority(engine: EngineProcess): Promise<string | null>;
}

export interface PlatformCheck extends ConformanceCheck<PlatformCheckContext> {
    /** A longer per-check timeout than the run's, for checks that wait for several heartbeats. */
    timeoutMs?(expectations: PlatformExpectations): number;
}

export interface PlatformSuite extends ConformanceSuite<PlatformCheckContext> {
    readonly checks: readonly PlatformCheck[];
}
