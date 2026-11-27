import type { Duplex } from 'node:stream';

import { KNOWN_CAPABILITIES, Timestamp, supports } from '@ptbk/engine-api';
import type { InMemoryEngineCore, UiUpdater } from '@ptbk/engine-api/in-memory';
import type { Hostname, OwnerSetupCommitment } from '@ptbk/protocol';
import {
    CLOSE_CODE,
    TUNNEL_FEATURES,
    TUNNEL_PROTOCOL_VERSIONS,
    TunnelFeature,
    defaultHostname,
    ed25519PublicKeyToBytes,
} from '@ptbk/protocol';

import type { ControlServer, FaultSettings } from '../adapters/control-server';
import { createFaultSettings, startControlServer } from '../adapters/control-server';
import { createEngineApiRoutes } from '../adapters/http/api-routes';
import { createGatewayRoutes } from '../adapters/http/dev-login';
import { createLiveChannelRoute } from '../adapters/http/live-channel-route';
import type { GatewayPageFiles } from '../adapters/http/gateway-page-files';
import type { PasskeyRouteDeps } from '../adapters/http/passkey-routes';
import { SETUP_PATH, createPasskeyRoutes } from '../adapters/http/passkey-routes';
import { createSimpleWebAuthnCeremonies } from '../adapters/simplewebauthn-ceremonies';
import type { PasskeyCeremonies } from '../domain/gateway/passkey-ceremonies';
import { createChallenges } from '../domain/gateway/passkey-ceremonies';
import type { PasskeyStore } from '../domain/gateway/passkey-gateway';
import { createJoinGateway } from '../domain/gateway/join-gateway';
import { createInMemorySpentTickets } from '../domain/gateway/spent-tickets';
import type { SpentTicketStore } from '../domain/gateway/spent-tickets';
import { createInMemoryPasskeyStore, createPasskeyGateway } from '../domain/gateway/passkey-gateway';
import type { SetupSecretStore } from '../domain/onboarding/setup-secret';
import { createInMemorySetupSecretStore, createSetupSecrets } from '../domain/onboarding/setup-secret';
import type { Faults } from '../adapters/http/fault-middleware';
import type { HttpApp } from '../adapters/http/http-app';
import { createHttpApp } from '../adapters/http/http-app';
import type { Route } from '../adapters/http/route';
import { createSpikeRoutes } from '../adapters/http/spike-routes';
import { createUiRoutes } from '../adapters/http/ui-routes';
import { tlsCertificateInfo } from '../adapters/certificate-fingerprint';
import { createClientHelloRouter } from '../adapters/client-hello-router';
import { createTlsAlpnResponder } from '../adapters/tls-alpn-responder';
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
import type { RateLimiter, WindowRateLimiter } from '../domain/rate-limit/rate-limiter';
import type { Registration, RegistrationStore } from '../domain/registration/registration';
import type { AcmeChallenges } from '../domain/tls/acme-challenges';
import { createAcmeChallenges } from '../domain/tls/acme-challenges';
import type { CertificateSource, ManagedCertificateSource } from '../domain/tls/certificate-source';
import type { RemoteAddress } from '../domain/tunnel/tunnel-stream';
import type { RelayDialer } from '../domain/tunnel/relay-dialer';
import type { RelayLink, RelayLinkState, TunnelOfferConfig } from '../domain/tunnel/relay-link';
import { createRelayLink } from '../domain/tunnel/relay-link';
import type { EngineRuntime } from '../domain/state/engine-runtime';
import { createEngineRuntime } from '../domain/state/engine-runtime';
import { capabilitiesFor } from '../domain/state/capabilities';
import { startLiveBrowserTicks } from '../domain/state/live-browser';
import { createSeededSequence, hashSeed } from '../domain/state/seed-random';
import type { RelayTarget } from '../domain/tunnel/relay-target';
import { relayTargetOf } from '../domain/tunnel/relay-target';
import type { StreamEvents } from '../domain/tunnel/tunnel-stream';
import type { BundleStore } from '../domain/ui/bundle-store';
import type { UiLoader, UiLoaderDeps } from '../domain/ui/ui-loader';
import { createUiLoader } from '../domain/ui/ui-loader';
import { uiUpdateCheckOf } from '../domain/ui/ui-update';
import type { AddressGap } from '../domain/onboarding/address';
import { addressGaps } from '../domain/onboarding/address';
import type { LinkAnswer, OperatorApi } from '../domain/onboarding/operator-api';
import { hasOwner } from '../domain/onboarding/owner';
import type { BrowserOpener } from '../domain/onboarding/setup-link-delivery';
import { setupLinkDelivery } from '../domain/onboarding/setup-link-delivery';
import { loadRegistration } from '../domain/registration/register';
import type { MockEngineConfig } from './config';
import { engineStatus } from './engine-status';
import { establishRegistration } from './establish-registration';
import type { Say } from './operator-lines';
import { WAITING } from './operator-lines';
import { ENGINE_COMMAND, retrySentence } from './registration-messages';
import { localClockTime, openSetupLink, setupLinkLines } from './setup-link-command';
import type { StartupProgress } from './startup-progress';
import { HANDOFF_SETUP_LINE, NO_OWNER_LINE, createStartupProgress } from './startup-progress';

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
    /** TLS-ALPN-01 challenges the ACME source has pending; without it no `acme-tls/1` connection is ever answered. */
    readonly challenges?: AcmeChallenges;
    /** Required with `PTBK_DASHBOARD_URL`: registration and heartbeat. */
    readonly dashboard?: DashboardDeps | undefined;
    /** Required with `PTBK_UI_RELEASE_URL`: the UI loader's release store, bundle store, state and verifiers. */
    readonly ui?: UiLoaderDeps | undefined;
    /** The operator's terminal, when the engine runs in one; never given when stdout is a log stream. */
    readonly say?: Say | null;
    /**
     * Given by the CLI that runs the engine in the foreground: when the address first works without an owner, the
     * engine shows the setup link on its terminal (`say`) and opens it when `mayOpen`, unless `connect` took that over.
     * Without it, or without a terminal, the engine only points at `setup-link`.
     */
    readonly firstSetupLink?: {
        readonly mayOpen: boolean;
        readonly openBrowser: BrowserOpener;
        /** The terminal renders OSC 8 hyperlinks, so the printed link is clickable. */
        readonly hyperlinks: boolean;
    };
    /**
     * The owner's setup: the stores, WebAuthn and the reference pages. Without it the secret and passkeys live in memory
     * and no `/setup` is served, so `setup-link` waits for it (tests that need neither).
     */
    readonly onboarding?: OnboardingDeps;
    /** Serves the operator API to the host's commands (the Unix socket); none in tests that drive `operator` directly. */
    readonly operatorChannel?: (api: OperatorApi) => Promise<{ close(): Promise<void> }>;
    /** The in-tunnel routes' limiter; a fresh one when absent. */
    readonly rateLimiter?: WindowRateLimiter;
}

export interface OnboardingDeps {
    readonly setupSecrets: SetupSecretStore;
    /** The pairing tab's handoff slot (ADR 0023); in memory without it. */
    readonly ownerHandoff?: SetupSecretStore;
    readonly passkeys: PasskeyStore;
    /** Access tickets the join page spent; in memory without it. */
    readonly spentTickets?: SpentTicketStore;
    readonly ceremonies?: PasskeyCeremonies;
    readonly pages: GatewayPageFiles;
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
    /** One per relay to dial, each independent of the others; none while the engine waits to be linked. */
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
    /** Null in the M1 dev mode (no `PTBK_DASHBOARD_URL`), and until `connect` links an engine started without one. */
    readonly registration: Registration | null;
    /** Null in the M1 dev mode. */
    readonly heartbeat: HeartbeatLoop | null;
    /** Null without `PTBK_UI_RELEASE_URL`: then the app's routes answer 503. */
    readonly ui: UiLoader | null;
    /** What the host's commands ask, also served on the operator channel. */
    readonly operator: OperatorApi;
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

function configuredUiLoader(
    config: MockEngineConfig,
    deps: MockEngineDeps,
    runtime: EngineRuntime,
    progress: StartupProgress,
): UiLoader | null {
    if (config.ui === null) return null;
    if (deps.ui === undefined) throw new Error('PTBK_UI_RELEASE_URL is set but no UI loader adapters were given');
    return createUiLoader({
        updatePolicy: config.ui.updatePolicy,
        checkIntervalS: config.ui.checkIntervalS,
        deps: deps.ui,
        clock: deps.clock,
        logger: deps.logger,
        random: deps.random,
        onActive: (bundle) => {
            if (bundle !== undefined) progress.ui(bundle.version);
            runtime.setUi(
                bundle === undefined
                    ? null
                    : { version: bundle.version, bundleSha256: bundle.sha256, releaseLogIndex: bundle.logIndex },
            );
        },
        onChecked: (outcome, atMs) => {
            runtime.setUiUpdateCheck(uiUpdateCheckOf(outcome, atMs));
        },
    });
}

/**
 * The loader as `updates@1` sees it. Check-now runs the scheduled check early (`checkEarly`), never the owner's
 * approval under `manual`, which the core refuses before it gets here; it answers what the panel now reports.
 */
function uiUpdaterOf(loader: UiLoader, runtime: EngineRuntime, clock: Clock): UiUpdater {
    return {
        policy: () => loader.policy().kind,
        nextCheckAt() {
            const atMs = loader.nextCheckAtMs();
            return atMs === null ? null : Timestamp.parse(new Date(Math.ceil(atMs / 1000) * 1000).toISOString());
        },
        async checkNow() {
            const outcome = await loader.checkEarly();
            return (
                runtime.controller().updateSecurity({}).ui.lastUpdateCheck ?? uiUpdateCheckOf(outcome, clock.nowMs())
            );
        },
    };
}

/** `PTBK_RELAYS` when set (an operator override, and always in the M1 dev mode), else the registration's relays. */
function relaysToDial(config: MockEngineConfig, registration: Registration | null): readonly RelayTarget[] {
    if (registration === null || config.relays.length > 0) return config.relays;
    return registration.relays.map(relayTargetOf);
}

export async function startMockEngine(config: MockEngineConfig, deps: MockEngineDeps): Promise<MockEngine> {
    const { logger } = deps;
    const startedAtMs = deps.clock.nowMs();
    const identity = await deps.identityStore.loadOrCreate();
    const hostname = defaultHostname(identity.engineId, config.engineDomain);
    // Set by `connect` on a terminal when it links this engine: that command shows the first setup link instead.
    let connectShowsSetupLink = false;
    // Assigned once the setup secrets exist; the first link is shown only after startup.
    let mayOpenFirstLink = (): boolean => false;
    const progress = createStartupProgress({
        logger,
        say: deps.say ?? null,
        engineId: identity.engineId,
        hostname,
        setupLink: {
            shownBy: () => {
                if (connectShowsSetupLink) return 'connect';
                const delivery = setupLinkDelivery({
                    terminal: (deps.say ?? null) !== null && deps.firstSetupLink !== undefined,
                    ownerSetUp: false,
                    mayOpen: mayOpenFirstLink(),
                });
                return delivery === 'none' ? 'operator' : 'engine';
            },
            show: () => {
                showFirstSetupLink().catch((error: unknown) => {
                    logger.error('setup-link.show-failed', {
                        problem: error instanceof Error ? error.name : 'unknown',
                    });
                });
            },
        },
    });
    progress.identity();
    const dashboard = config.dashboard === null ? null : { config: config.dashboard, deps: dashboardDeps(deps) };
    // Accepted once the owner is known: a commitment means nothing to an engine that already has one.
    const handedOver: {
        current: { readonly commitment: OwnerSetupCommitment; readonly registeredAtMs: number } | null;
    } = { current: null };
    let registration =
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
                  clock: deps.clock,
                  random: deps.random,
                  signal: new AbortController().signal,
                  onRetry: (retry) => {
                      deps.say?.(`${WAITING} ${retrySentence(retry)}`);
                  },
                  onOwnerSetupCommitment: (commitment, registeredAtMs) => {
                      handedOver.current = { commitment, registeredAtMs };
                  },
              });
    const linkedAtStart = dashboard === null || registration !== null;
    const faults = createFaultSettings(config.faults);
    // The session store needs the runtime, and the runtime's cores ask the store; neither asks before startup ends.
    let sessionStore: SessionStore | null = null;
    const runtime = await createEngineRuntime({
        seed: config.seed,
        scenario: config.scenario,
        epoch: config.seedEpoch,
        identity: {
            engineId: identity.engineId,
            hostname,
            mode: linkedAtStart ? config.mode : 'local',
            version: config.engineVersion,
        },
        clock: deps.clock,
        capabilities: capabilitiesFor(config.capabilities),
        simulation: config.simulation,
        passkeys: config.passkeys,
        ...(config.onboarding === null ? {} : { onboarding: config.onboarding }),
        liveBrowser: config.liveBrowser,
        voice: config.voice,
        dashboardAttention: config.dashboardAttention,
        browserPermissions: (memberId, sessionId) => sessionStore?.permissionsOf(memberId, sessionId) ?? null,
        faults: () => faults.plan(),
        onSimulationError: (error) => {
            logger.error('simulation.error', { problem: error instanceof Error ? error.name : 'unknown' });
        },
    });
    const sessions = createSessionStore({ engine: () => runtime.controller(), clock: deps.clock, random: deps.random });
    sessionStore = sessions;
    const stopLiveBrowser = config.liveBrowser
        ? startLiveBrowserTicks(deps.clock, () => {
              try {
                  runtime.controller().browserTick();
              } catch (error) {
                  logger.error('live-browser.tick-failed', {
                      problem: error instanceof Error ? error.name : 'unknown',
                  });
              }
          })
        : null;
    const ownerSetUpNow = (): boolean => hasOwner(runtime.controller().inspect());
    // Assigned below; the owner changes only through requests and commands that come after startup.
    let onboardingChanged = (): void => undefined;
    let ownerWasSetUp = ownerSetUpNow();
    const onboarding = deps.onboarding;
    const setupSecrets = createSetupSecrets({
        store: onboarding?.setupSecrets ?? createInMemorySetupSecretStore(),
        random: deps.random,
        clock: deps.clock,
        hasOwner: ownerSetUpNow,
        ...(config.ownerHandoff ? { handoff: onboarding?.ownerHandoff ?? createInMemorySetupSecretStore() } : {}),
    });
    const passkeyStore = onboarding?.passkeys ?? createInMemoryPasskeyStore();
    const ceremonies = onboarding?.ceremonies ?? createSimpleWebAuthnCeremonies();
    const passkeyChallenges = createChallenges({ random: deps.random, clock: deps.clock });
    const passkeyGateway = createPasskeyGateway({
        engine: () => runtime.controller(),
        sessions,
        secrets: setupSecrets,
        passkeys: passkeyStore,
        ceremonies,
        challenges: passkeyChallenges,
        random: deps.random,
        clock: deps.clock,
        logger,
        onOwnerChanged: () => {
            onboardingChanged();
            const setUp = ownerSetUpNow();
            // The dashboard's tab waits on `members` turning non-zero: tell it now, not at the next interval.
            if (setUp && !ownerWasSetUp) heartbeat?.beatNow();
            ownerWasSetUp = setUp;
        },
        onOwnerSetUp: (slot) => {
            if (slot === 'owner-handoff') deps.say?.(HANDOFF_SETUP_LINE);
        },
    });
    await passkeyGateway.restore();
    await setupSecrets.loadHandoff();
    if (handedOver.current !== null) {
        const { commitment, registeredAtMs } = handedOver.current;
        const accepted = await setupSecrets.acceptHandoff(commitment, registeredAtMs);
        logger.info('owner-handoff.registration', { outcome: accepted });
    }
    const joinGateway = createJoinGateway({
        engine: () => runtime.controller(),
        engineId: identity.engineId,
        memberKey: () => {
            const key = registration?.memberKey ?? null;
            return key === null ? null : ed25519PublicKeyToBytes(key);
        },
        passkeys: passkeyStore,
        spentTickets: onboarding?.spentTickets ?? createInMemorySpentTickets(),
        sessions,
        ceremonies,
        challenges: passkeyChallenges,
        random: deps.random,
        clock: deps.clock,
        engineNowMs: () => runtime.clock.nowMs(),
        logger,
    });
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
                  onStatus: (status) => {
                      runtime.setHeartbeat(status);
                  },
                  teams: joinGateway,
                  // Only once a browser can use the address, so the pairing tab never lands on a certificate error.
                  ownerHandoff: () => setupSecrets.handoffLive() && addressGapsNow().length === 0,
                  attention: () => runtime.controller().attention(),
              });
    const rateLimiter = deps.rateLimiter ?? createWindowRateLimiter({ clock: deps.clock });
    runtime.onReset(() => {
        sessions.clear();
        rateLimiter.clear();
        passkeyGateway.restore().catch((error: unknown) => {
            logger.error('passkeys.restore-failed', { problem: error instanceof Error ? error.name : 'unknown' });
        });
    });
    const ui = configuredUiLoader(config, deps, runtime, progress);
    if (ui !== null) runtime.setUiUpdater(uiUpdaterOf(ui, runtime, deps.clock));
    const server =
        deps.certificates === undefined
            ? null
            : createEngineServer({
                  engineId: identity.engineId,
                  certificates: deps.certificates,
                  ...(deps.challenges === undefined ? {} : { challenges: deps.challenges }),
                  core: () => runtime.core(),
                  microphone: () => supports(runtime.current(), KNOWN_CAPABILITIES.voiceInput),
                  sessions,
                  faults,
                  seed: config.seed,
                  devLogin: config.devLogin,
                  canary: spikeCanary(deps.random),
                  rateLimiter,
                  bundles: ui?.store ?? NO_BUNDLES,
                  ...(onboarding === undefined
                      ? {}
                      : {
                            passkeys: {
                                gateway: passkeyGateway,
                                files: onboarding.pages,
                                ownerSetUp: ownerSetUpNow,
                                command: ENGINE_COMMAND,
                                join: joinGateway,
                            },
                        }),
                  clock: deps.clock,
                  logger,
              });
    let links: readonly RelayLink[] = [];
    let certificateNotAfter: string | null = null;
    // The pairing tab opens the setup page itself; a second page racing it on the same desktop would only confuse.
    mayOpenFirstLink = (): boolean => (deps.firstSetupLink?.mayOpen ?? false) && !setupSecrets.handoffLive();
    const addressGapsNow = (): AddressGap[] =>
        addressGaps({
            relaysReady: links.filter((link) => link.state().kind === 'ready').length,
            certificateValid: certificateNotAfter !== null && Date.parse(certificateNotAfter) > deps.clock.nowMs(),
            setupPageServed: server !== null && onboarding !== undefined,
        });
    onboardingChanged = (): void => {
        progress.onboarding({ addressGaps: addressGapsNow(), ownerSetUp: ownerSetUpNow() });
    };
    deps.certificates?.addHostnames([hostname]);
    const reportCertificate = (): void => {
        const credentials = deps.certificates?.current(hostname);
        if (credentials === undefined) return;
        const certificate = tlsCertificateInfo(credentials.certificateChainPem);
        runtime.setTlsCertificate(certificate);
        if (certificate.notAfter !== certificateNotAfter) progress.certificate(certificate.notAfter);
        certificateNotAfter = certificate.notAfter;
        onboardingChanged();
    };
    const stopReportingCertificate = deps.certificates?.onChange(reportCertificate);
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

    // The first beat waits for the first tunnel, so the dashboard's first look already shows the engine reachable;
    // one interval at most, so an engine no relay takes is still seen online.
    let heartbeatStarted = false;
    let cancelHeartbeatFallback: (() => void) | null = null;
    const startHeartbeat = (): void => {
        if (heartbeatStarted || heartbeat === null || dashboard === null) return;
        heartbeatStarted = true;
        cancelHeartbeatFallback?.();
        heartbeat.start();
    };
    const relayCount = (): void => {
        progress.relays(links.filter((link) => link.state().kind === 'ready').length, links.length);
    };

    function dial(relays: readonly RelayTarget[]): void {
        links = relays.map((relay) =>
            createRelayLink({
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
                onStateChange: stateListener(relay, runtime, deps, (state) => {
                    if (state.kind === 'ready') startHeartbeat();
                    relayCount();
                    onboardingChanged();
                }),
            }),
        );
        for (const link of links) link.start();
        if (heartbeat !== null && dashboard !== null) {
            cancelHeartbeatFallback = deps.clock.setTimeout(startHeartbeat, dashboard.config.heartbeatIntervalS * 1000);
        }
    }

    function goOnline(linked: Registration | null): void {
        if (linked !== null) {
            runtime.setDashboardUrl(linked.dashboardUrl);
            runtime.setMode(config.mode);
        }
        dial(relaysToDial(config, linked));
    }

    let linking: Promise<LinkAnswer> | null = null;
    async function linkStored(linked: NonNullable<typeof dashboard>): Promise<LinkAnswer> {
        let stored: Registration | null;
        try {
            stored = await loadRegistration({
                store: linked.deps.registrations,
                identity,
                dashboardUrl: linked.config.url,
                engineDomain: config.engineDomain,
            });
        } catch (error) {
            logger.error('registration.refused-stored', { problem: error instanceof Error ? error.name : 'unknown' });
            return { outcome: 'not-registered' };
        }
        if (stored === null) return { outcome: 'not-registered' };
        registration = stored;
        // `connect` stored the pairing tab's slot next to the registration it just made.
        await setupSecrets.loadHandoff();
        logger.info('registration.linked', { engineId: stored.engineId, relays: stored.relays.length });
        progress.linked(false);
        goOnline(stored);
        return { outcome: 'linked', relays: links.length };
    }

    const operator: OperatorApi = {
        status: () =>
            engineStatus({
                engineId: identity.engineId,
                hostname,
                version: config.engineVersion,
                registration,
                withDashboard: dashboard !== null,
                links,
                certificateNotAfter,
                uiVersion: ui?.store.active()?.version ?? null,
                updatePolicy: ui?.policy() ?? { kind: 'auto' },
                ownerSetUp: ownerSetUpNow(),
                heartbeat: heartbeat?.status() ?? null,
                addressGaps: addressGapsNow(),
            }),
        async link({ callerShowsSetupLink }) {
            if (dashboard === null || registration !== null) return { outcome: 'already-linked' };
            // Claimed before the relays are dialled, so it is settled by the time the address first works.
            if (callerShowsSetupLink) connectShowsSetupLink = true;
            // Two `connect` calls racing share one attempt, so the engine never dials twice.
            linking ??= linkStored(dashboard).finally(() => {
                linking = null;
            });
            const answer = await linking;
            if (answer.outcome === 'not-registered') connectShowsSetupLink = false;
            return answer;
        },
        async setupLink() {
            const missing = addressGapsNow();
            if (missing.length > 0) return { outcome: 'not-ready', missing };
            const issued = await setupSecrets.issue();
            if (issued.kind === 'owner-exists') return { outcome: 'owner-exists' };
            // Never logged: the link makes whoever opens it first the owner, and log streams get shipped.
            logger.info('setup-link.issued', { expiresAt: new Date(issued.expiresAtMs).toISOString() });
            return {
                outcome: 'created',
                url: `https://${hostname}${SETUP_PATH}#${issued.secret.reveal()}`,
                expiresAt: new Date(issued.expiresAtMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
            };
        },
        resetOwner: () => passkeyGateway.resetOwner(),
    };
    /** The engine's own terminal gets the first link, issued like `setup-link`'s and never logged. */
    async function showFirstSetupLink(): Promise<void> {
        const say = deps.say ?? null;
        const first = deps.firstSetupLink;
        if (say === null || first === undefined) return;
        const delivery = setupLinkDelivery({
            terminal: true,
            ownerSetUp: ownerSetUpNow(),
            mayOpen: mayOpenFirstLink(),
        });
        if (delivery === 'none') return;
        const answer = await operator.setupLink();
        if (answer.outcome === 'not-ready') {
            say(NO_OWNER_LINE);
        }
        if (answer.outcome !== 'created') return;
        for (const line of setupLinkLines(answer.url, localClockTime(answer.expiresAt), first.hyperlinks)) say(line);
        if (delivery === 'print-and-open') await openSetupLink(answer.url, first.openBrowser, say);
    }

    let operatorChannel: { close(): Promise<void> } | null = null;
    try {
        operatorChannel = deps.operatorChannel === undefined ? null : await deps.operatorChannel(operator);
    } catch (error) {
        // Nothing started so far may outlive a refused start: a listening control server would keep the process up.
        runtime.simulation().stop();
        stopLiveBrowser?.();
        stopReportingCertificate?.();
        await control?.close();
        server?.close();
        deps.certificates?.close();
        throw error;
    }

    logger.info('engine.started', {
        engineId: identity.engineId,
        hostname,
        version: config.engineVersion,
        relays: linkedAtStart ? relaysToDial(config, registration).length : 0,
        dashboard: registration !== null,
        proxy: config.proxy !== null,
        scenario: config.scenario,
        seed: config.seed,
    });
    if (linkedAtStart) {
        if (registration !== null) progress.linked(true);
        goOnline(registration);
    } else {
        progress.notLinked();
    }
    reportCertificate();
    ui?.start();

    return {
        identity,
        hostname,
        get links() {
            return links;
        },
        runtime,
        sessions,
        faults,
        control,
        get registration() {
            return registration;
        },
        heartbeat,
        ui,
        operator,
        onStream(next) {
            handler = next;
            return () => {
                if (handler === next) handler = defaultHandler;
            };
        },
        async close() {
            runtime.simulation().stop();
            stopLiveBrowser?.();
            stopReportingCertificate?.();
            cancelHeartbeatFallback?.();
            const stopping = Promise.all([heartbeat?.stop(), ui?.stop(), ...links.map((link) => link.stop())]);
            await operatorChannel?.close();
            await stopping;
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
    onChange: (state: RelayLinkState) => void,
): (state: RelayLinkState) => void {
    const { certificates, onLinkState } = deps;
    return (state) => {
        runtime.setRelayStatus(relay.relayId, RELAY_STATUS[state.kind]);
        if (state.kind === 'ready') {
            certificates?.addHostnames(state.session.hostnames);
            runtime.setHostnames(state.session.hostnames);
        }
        onChange(state);
        onLinkState?.(relay, state);
    };
}

const SPIKE_CANARY_BYTES = 16;

function spikeCanary(random: Random): string {
    return Buffer.from(random.bytes(SPIKE_CANARY_BYTES)).toString('hex');
}

export type PasskeyPages = Omit<PasskeyRouteDeps, 'engineId' | 'devLogin'>;

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
    /** `/setup`, the passkey sign-in and step-up pages and their WebAuthn endpoints; without it only the dev login. */
    readonly passkeys?: PasskeyPages;
}): readonly Route[] {
    return [
        ...createSpikeRoutes({ engineId: deps.engineId, clock: deps.clock, canary: deps.canary }),
        ...createGatewayRoutes({
            sessions: deps.sessions,
            members: () => deps.core().controller.inspect().members,
            devLogin: deps.devLogin,
            passkeyPages: deps.passkeys !== undefined,
        }),
        ...(deps.passkeys === undefined
            ? []
            : createPasskeyRoutes({ ...deps.passkeys, engineId: deps.engineId, devLogin: deps.devLogin })),
        ...createEngineApiRoutes({ core: deps.core }),
        createLiveChannelRoute({ core: deps.core }),
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
    /** Pending TLS-ALPN-01 challenges; none by default, so every `acme-tls/1` hello is refused. */
    readonly challenges?: AcmeChallenges;
    readonly core: () => InMemoryEngineCore;
    /** Whether the engine advertises `voice-input@1` right now, so `Permissions-Policy` allows the microphone; no by default. */
    readonly microphone?: () => boolean;
    readonly sessions: SessionStore;
    readonly faults: FaultSettings;
    /** Seeds fault decisions. */
    readonly seed: number;
    readonly devLogin: boolean;
    /** Shown on the spike page; see `SpikeRouteDeps.canary`. */
    readonly canary: string;
    /** The UI bundles the app's routes serve; without it they answer 503. */
    readonly bundles?: Pick<BundleStore, 'active' | 'read'>;
    readonly passkeys?: PasskeyPages;
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

/**
 * Tunnel streams (throttled by the fault plan) → ClientHello router → TLS (engine key, chosen by SNI) → HTTP app, or,
 * for a TLS-ALPN-01 validation with a challenge pending, the challenge responder.
 */
export function createEngineServer(deps: EngineServerDeps): EngineServer {
    const http = createHttpApp({
        routes: createInTunnelRoutes(deps),
        rateLimiter: deps.rateLimiter ?? createWindowRateLimiter({ clock: deps.clock }),
        logger: deps.logger,
        sessions: deps.sessions,
        faults: createFaults(deps.faults, deps.seed, deps.clock),
        ...(deps.microphone === undefined ? {} : { microphone: deps.microphone }),
    });
    const tls = createTlsStreamServer({
        certificates: deps.certificates,
        logger: deps.logger,
        onSecureConnection: (socket, connection) => {
            http.serve(socket, connection);
        },
    });
    const challenges = deps.challenges ?? createAcmeChallenges();
    const responder = createTlsAlpnResponder({ challenges, logger: deps.logger });
    const router = createClientHelloRouter({
        challenges,
        responder,
        normal: (stream, remote) => {
            tls.handle(stream, remote);
        },
        clock: deps.clock,
        logger: deps.logger,
    });
    return {
        http,
        tls,
        handle(stream, remote) {
            const throttled = throttleDuplex(stream, {
                clock: deps.clock,
                bytesPerS: () => deps.faults.plan().slowTunnelBytesPerS,
            });
            router.handle(throttled, remote);
        },
        close() {
            router.close();
            responder.close();
            tls.close();
            http.close();
        },
    };
}
