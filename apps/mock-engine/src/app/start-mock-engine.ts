import type { Duplex } from 'node:stream';

import type { InMemoryEngineCore } from '@ptbk/engine-api/in-memory';
import type { Hostname } from '@ptbk/protocol';
import { CLOSE_CODE, TUNNEL_FEATURES, TUNNEL_PROTOCOL_VERSIONS, TunnelFeature, defaultHostname } from '@ptbk/protocol';

import type { ControlServer, FaultSettings } from '../adapters/control-server';
import { createFaultSettings, startControlServer } from '../adapters/control-server';
import { createEngineApiRoutes } from '../adapters/http/api-routes';
import { createGatewayRoutes } from '../adapters/http/dev-login';
import type { Faults } from '../adapters/http/fault-middleware';
import type { HttpApp } from '../adapters/http/http-app';
import { createHttpApp } from '../adapters/http/http-app';
import type { Route } from '../adapters/http/route';
import { createSpikeRoutes } from '../adapters/http/spike-routes';
import { createUiRoutes } from '../adapters/http/ui-routes';
import type { TlsStreamServer } from '../adapters/tls-stream-server';
import { createTlsStreamServer } from '../adapters/tls-stream-server';
import type { TunnelDuplex } from '../adapters/tunnel-duplex';
import { openTunnelDuplex } from '../adapters/tunnel-duplex';
import { throttleDuplex } from '../adapters/tunnel-throttle';
import { createRuntimeEngineStats } from '../adapters/runtime-engine-stats';
import type { Clock } from '../domain/clock';
import type { DashboardApi } from '../domain/dashboard/dashboard-api';
import { createFaultInjector } from '../domain/faults/fault-injector';
import type { SessionStore } from '../domain/gateway/sessions';
import { createSessionStore } from '../domain/gateway/sessions';
import type { HeartbeatLoop } from '../domain/heartbeat/heartbeat-loop';
import { createHeartbeatLoop } from '../domain/heartbeat/heartbeat-loop';
import { createScenarioSystemStats } from '../domain/heartbeat/scenario-system-stats';
import type { SeqStore } from '../domain/heartbeat/seq-store';
import type { SystemStats } from '../domain/heartbeat/system-stats';
import type { EngineIdentity, IdentityStore } from '../domain/identity/engine-identity';
import type { Logger } from '../domain/logger';
import type { Random } from '../domain/random';
import { createWindowRateLimiter } from '../domain/rate-limit/rate-limiter';
import type { RateLimiter } from '../domain/rate-limit/rate-limiter';
import type { Registration, RegistrationStore } from '../domain/registration/registration';
import type { CertificateSource, ManagedCertificateSource } from '../domain/tls/certificate-source';
import type { RemoteAddress } from '../domain/tunnel/tunnel-stream';
import type { RelayDialer } from '../domain/tunnel/relay-dialer';
import type { RelayLink, RelayLinkState, TunnelOfferConfig } from '../domain/tunnel/relay-link';
import { createRelayLink } from '../domain/tunnel/relay-link';
import type { EngineRuntime } from '../domain/state/engine-runtime';
import { createEngineRuntime } from '../domain/state/engine-runtime';
import { createSeededSequence, hashSeed } from '../domain/state/seed-random';
import type { RelayTarget } from '../domain/tunnel/relay-target';
import { relayTargetOf } from '../domain/tunnel/relay-target';
import type { StreamEvents } from '../domain/tunnel/tunnel-stream';
import type { BundleStore } from '../domain/ui/bundle-store';
import type { UiLoader, UiLoaderDeps } from '../domain/ui/ui-loader';
import { createUiLoader } from '../domain/ui/ui-loader';
import type { MockEngineConfig } from './config';
import { establishRegistration } from './establish-registration';

/** Everything `@ptbk/protocol` implements, so the mock always advertises exactly the current contract. */
export const DEFAULT_TUNNEL_OFFER: TunnelOfferConfig = Object.freeze({
    protocolVersions: Object.freeze([...TUNNEL_PROTOCOL_VERSIONS]),
    features: Object.freeze(TunnelFeature.array().parse([...TUNNEL_FEATURES])),
});

export interface MockEngineDeps {
    readonly logger: Logger;
    readonly clock: Clock;
    readonly random: Random;
    readonly identityStore: IdentityStore;
    readonly dialer: RelayDialer;
    readonly offer?: TunnelOfferConfig;
    readonly onLinkState?: (relay: RelayTarget, state: RelayLinkState) => void;
    /**
     * Certificates for the engine's hostnames; `close` stops them too. With it, every stream is served by the TLS
     * server and HTTP app inside the tunnel; without it (tunnel-only tests), streams go to `onStream` handlers or are
     * refused.
     */
    readonly certificates?: ManagedCertificateSource;
    /** Required with `PTBK_DASHBOARD_URL`: registration and heartbeat. */
    readonly dashboard?: DashboardDeps | undefined;
    /** Required with `PTBK_UI_RELEASE_URL`: the UI loader's release store, bundle store, state and verifiers. */
    readonly ui?: UiLoaderDeps | undefined;
}

export interface DashboardDeps {
    readonly api: DashboardApi;
    readonly registrations: RegistrationStore;
    readonly seqs: SeqStore;
    /** The host's figures, used with `MOCK_STATS=os`. */
    readonly systemStats: SystemStats;
}

/** A browser connection through `relay`; the TLS server inside the tunnel takes it from here. */
export type StreamHandler = (stream: TunnelDuplex, relay: RelayTarget) => void;

export interface MockEngine {
    readonly identity: EngineIdentity;
    /** `<engineId>.<engine domain>`. */
    readonly hostname: Hostname;
    /** One per configured relay, each independent of the others. */
    readonly links: readonly RelayLink[];
    /**
     * Replaces the stream handler (the TLS server, if `certificates` was given); returns a function that restores it.
     * Without any handler streams are refused.
     */
    onStream(handler: StreamHandler): () => void;
    /** The engine API's state: one in-memory core from `@ptbk/engine-api`, replaced by `/__mock/reset`. */
    readonly runtime: EngineRuntime;
    /** The gateway stand-in's sessions. */
    readonly sessions: SessionStore;
    readonly faults: FaultSettings;
    /** The dev-only control listener, when `MOCK_CONTROL=enabled`. */
    readonly control: ControlServer | null;
    /** Null in the M1 dev mode (no `PTBK_DASHBOARD_URL`). */
    readonly registration: Registration | null;
    /** Null in the M1 dev mode. */
    readonly heartbeat: HeartbeatLoop | null;
    /** Null without `PTBK_UI_RELEASE_URL`: then the app's routes answer 503. */
    readonly ui: UiLoader | null;
    /** Closes every tunnel cleanly and stops reconnecting. */
    close(): Promise<void>;
}

function ignore(): void {
    // A refused stream is closed before the mux could deliver anything to it.
}
const REFUSED_EVENTS: StreamEvents = Object.freeze({ data: ignore, sendCredit: ignore, closed: ignore });

function dashboardDeps(deps: MockEngineDeps): DashboardDeps {
    if (deps.dashboard === undefined) throw new Error('PTBK_DASHBOARD_URL is set but no dashboard adapters were given');
    return deps.dashboard;
}

/** What the app's routes serve while no loader is configured: nothing, so they answer 503. */
const NO_BUNDLES: Pick<BundleStore, 'active' | 'read'> = Object.freeze({
    active: () => undefined,
    read: () => Promise.resolve(undefined),
});

function configuredUiLoader(config: MockEngineConfig, deps: MockEngineDeps, runtime: EngineRuntime): UiLoader | null {
    if (config.ui === null) return null;
    if (deps.ui === undefined) throw new Error('PTBK_UI_RELEASE_URL is set but no UI loader adapters were given');
    return createUiLoader({
        updatePolicy: config.ui.updatePolicy,
        checkIntervalS: config.ui.checkIntervalS,
        deps: deps.ui,
        clock: deps.clock,
        logger: deps.logger,
        onActive: (bundle) => {
            runtime.setUi({ version: bundle.version, bundleSha256: bundle.sha256, releaseLogIndex: bundle.logIndex });
        },
    });
}

/** The registration's relays, unless `MOCK_RELAYS_OVERRIDE` keeps `PTBK_RELAYS` (and always in the M1 dev mode). */
function relaysToDial(config: MockEngineConfig, registration: Registration | null): readonly RelayTarget[] {
    if (registration === null || config.dashboard?.relaysOverride === true) return config.relays;
    return registration.relays.map(relayTargetOf);
}

export async function startMockEngine(config: MockEngineConfig, deps: MockEngineDeps): Promise<MockEngine> {
    const { logger } = deps;
    const startedAtMs = deps.clock.nowMs();
    const identity = await deps.identityStore.loadOrCreate();
    const hostname = defaultHostname(identity.engineId, config.engineDomain);
    const dashboard = config.dashboard === null ? null : { config: config.dashboard, deps: dashboardDeps(deps) };
    const registration =
        dashboard === null
            ? null
            : await establishRegistration({
                  dashboard: dashboard.config,
                  engineDomain: config.engineDomain,
                  engineVersion: config.engineVersion,
                  identity,
                  api: dashboard.deps.api,
                  store: dashboard.deps.registrations,
                  logger,
                  signal: new AbortController().signal,
              });
    const relays = relaysToDial(config, registration);
    const runtime = createEngineRuntime({
        seed: config.seed,
        scenario: config.scenario,
        epoch: config.seedEpoch,
        identity: { engineId: identity.engineId, hostname, mode: config.mode, version: config.engineVersion },
        clock: deps.clock,
    });
    if (registration !== null) runtime.setDashboardUrl(registration.dashboardUrl);
    const heartbeat =
        dashboard === null
            ? null
            : createHeartbeatLoop({
                  clock: deps.clock,
                  logger,
                  api: dashboard.deps.api,
                  seqs: dashboard.deps.seqs,
                  system:
                      config.stats === 'scenario'
                          ? createScenarioSystemStats(() => runtime.current().scenario)
                          : dashboard.deps.systemStats,
                  engine: createRuntimeEngineStats(runtime),
                  identity,
                  version: config.engineVersion,
                  intervalS: dashboard.config.heartbeatIntervalS,
                  startedAtMs,
                  onSent: (sent) => {
                      runtime.setLastHeartbeat(sent);
                  },
              });
    const sessions = createSessionStore({ engine: () => runtime.controller(), clock: deps.clock, random: deps.random });
    runtime.onReset(() => {
        sessions.clear();
    });
    const faults = createFaultSettings(config.faults);
    const ui = configuredUiLoader(config, deps, runtime);
    const server =
        deps.certificates === undefined
            ? null
            : createEngineServer({
                  engineId: identity.engineId,
                  certificates: deps.certificates,
                  core: () => runtime.core(),
                  sessions,
                  faults,
                  seed: config.seed,
                  devLogin: config.devLogin,
                  canary: spikeCanary(deps.random),
                  bundles: ui?.store ?? NO_BUNDLES,
                  clock: deps.clock,
                  logger,
              });
    deps.certificates?.addHostnames([hostname]);
    let handler: StreamHandler | null =
        server === null
            ? null
            : (stream) => {
                  server.handle(stream, {
                      family: stream.remoteFamily,
                      address: stream.remoteAddress,
                      port: stream.remotePort,
                  });
              };
    const defaultHandler = handler;
    const control =
        config.control === null
            ? null
            : await startControlServer({
                  ...config.control,
                  runtime,
                  sessions,
                  faults,
                  rateLimiter: createWindowRateLimiter({ clock: deps.clock }),
                  ...(heartbeat === null ? {} : { heartbeat: () => heartbeat.status() }),
                  ...(ui === null ? {} : { ui }),
                  logger,
                  now: () => new Date(deps.clock.nowMs()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
              });
    logger.info('engine.started', {
        engineId: identity.engineId,
        hostname,
        version: config.engineVersion,
        relays: relays.length,
        dashboard: registration !== null,
        proxy: config.proxy !== null,
        scenario: config.scenario,
        seed: config.seed,
    });

    const links = relays.map((relay) => {
        const onStateChange = stateListener(relay, runtime, deps);
        return createRelayLink({
            relay,
            identity,
            engineVersion: config.engineVersion,
            offer: deps.offer ?? DEFAULT_TUNNEL_OFFER,
            defaultHostname: hostname,
            dialer: deps.dialer,
            clock: deps.clock,
            random: deps.random,
            logger,
            onStream: (stream) => {
                if (handler === null) {
                    logger.warn('stream.refused', { relay: relay.url, stream: stream.id });
                    stream.close(CLOSE_CODE.REFUSED);
                    return REFUSED_EVENTS;
                }
                const duplex = openTunnelDuplex(stream);
                handler(duplex, relay);
                return duplex.events;
            },
            onStateChange,
        });
    });
    for (const link of links) link.start();
    heartbeat?.start();
    ui?.start();

    return {
        identity,
        hostname,
        links,
        runtime,
        sessions,
        faults,
        control,
        registration,
        heartbeat,
        ui,
        onStream(next) {
            handler = next;
            return () => {
                if (handler === next) handler = defaultHandler;
            };
        },
        async close() {
            await Promise.all([heartbeat?.stop(), ui?.stop(), ...links.map((link) => link.stop())]);
            await control?.close();
            server?.close();
            deps.certificates?.close();
            logger.info('engine.stopped', {});
        },
    };
}

const RELAY_STATUS: Readonly<Record<RelayLinkState['kind'], 'connected' | 'connecting' | 'disconnected'>> = {
    ready: 'connected',
    connecting: 'connecting',
    handshaking: 'connecting',
    idle: 'disconnected',
    backoff: 'disconnected',
    stopped: 'disconnected',
};

/** Relays confirm extra hostnames (custom domains) in `ready`; the engine needs certificates for those too. */
function stateListener(
    relay: RelayTarget,
    runtime: EngineRuntime,
    deps: MockEngineDeps,
): (state: RelayLinkState) => void {
    const { certificates, onLinkState } = deps;
    return (state) => {
        runtime.setRelayStatus(relay.relayId, RELAY_STATUS[state.kind]);
        if (state.kind === 'ready') {
            certificates?.addHostnames(state.session.hostnames);
            runtime.setHostnames(state.session.hostnames);
        }
        onLinkState?.(relay, state);
    };
}

const SPIKE_CANARY_BYTES = 16;

function spikeCanary(random: Random): string {
    return Buffer.from(random.bytes(SPIKE_CANARY_BYTES)).toString('hex');
}

/** Everything served inside the tunnel: spike pages, the gateway's pages, the engine API and the app (UI bundle). */
export function createInTunnelRoutes(deps: {
    readonly engineId: EngineIdentity['engineId'];
    readonly clock: Clock;
    readonly core: () => InMemoryEngineCore;
    readonly sessions: SessionStore;
    readonly devLogin: boolean;
    readonly canary: string;
    /** Without it, the app's routes answer 503 (no UI loader). */
    readonly bundles?: Pick<BundleStore, 'active' | 'read'>;
}): readonly Route[] {
    return [
        ...createSpikeRoutes({ engineId: deps.engineId, clock: deps.clock, canary: deps.canary }),
        ...createGatewayRoutes({
            sessions: deps.sessions,
            members: () => deps.core().controller.inspect().members,
            devLogin: deps.devLogin,
        }),
        ...createEngineApiRoutes({ core: deps.core }),
        ...createUiRoutes({ store: deps.bundles ?? NO_BUNDLES }),
    ];
}

/** Fault decisions drawn from `MOCK_SEED`, so a run with the same plan and seed fails the same requests. */
export function createFaults(settings: FaultSettings, seed: number, clock: Clock): Faults {
    const random = createSeededSequence(hashSeed(seed, 'faults'));
    return { injector: createFaultInjector({ plan: () => settings.plan(), random }), clock };
}

export interface EngineServerDeps {
    readonly engineId: EngineIdentity['engineId'];
    readonly certificates: CertificateSource;
    readonly core: () => InMemoryEngineCore;
    readonly sessions: SessionStore;
    readonly faults: FaultSettings;
    /** Seeds fault decisions. */
    readonly seed: number;
    readonly devLogin: boolean;
<<<<<<< HEAD
    /** Shown on the spike page; see `SpikeRouteDeps.canary`. */
    readonly canary: string;
=======
    /** The UI bundles the app's routes serve; without it they answer 503. */
    readonly bundles?: Pick<BundleStore, 'active' | 'read'>;
>>>>>>> c94225d (feat(mock-engine): add the UI loader core, stores and routes)
    readonly clock: Clock;
    readonly logger: Logger;
    readonly rateLimiter?: RateLimiter;
}

export interface EngineServer {
    readonly http: HttpApp;
    readonly tls: TlsStreamServer;
    /** Serves one browser connection: a tunnel stream, or any duplex standing in for one. */
    handle(stream: Duplex, remote: RemoteAddress): void;
    close(): void;
}

/** Tunnel streams (throttled by the fault plan) → TLS (engine key, chosen by SNI) → HTTP app. */
export function createEngineServer(deps: EngineServerDeps): EngineServer {
    const http = createHttpApp({
        routes: createInTunnelRoutes(deps),
        rateLimiter: deps.rateLimiter ?? createWindowRateLimiter({ clock: deps.clock }),
        logger: deps.logger,
        sessions: deps.sessions,
        faults: createFaults(deps.faults, deps.seed, deps.clock),
    });
    const tls = createTlsStreamServer({
        certificates: deps.certificates,
        logger: deps.logger,
        onSecureConnection: (socket, connection) => {
            http.serve(socket, connection);
        },
    });
    return {
        http,
        tls,
        handle(stream, remote) {
            const throttled = throttleDuplex(stream, {
                clock: deps.clock,
                bytesPerS: () => deps.faults.plan().slowTunnelBytesPerS,
            });
            tls.handle(throttled, remote);
        },
        close() {
            tls.close();
            http.close();
        },
    };
}
