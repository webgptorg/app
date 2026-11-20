import { duplexPair } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { checkServerIdentity, connect } from 'node:tls';

import type { EngineApiClient } from '@ptbk/engine-api';
import { KNOWN_CAPABILITIES, createFetchEngineApiClient, supports } from '@ptbk/engine-api';
import type { InMemoryEngineCore } from '@ptbk/engine-api/in-memory';
import { createCryptoRandom } from '@ptbk/protocol';

import type { ControlServer, FaultSettings } from '../adapters/control-server';
import { createFaultSettings, startControlServer } from '../adapters/control-server';
import { createDevCa, createDevCaCertificateSource } from '../adapters/dev-ca';
import type { EngineServer } from '../app/start-mock-engine';
import { createEngineServer } from '../app/start-mock-engine';
import type { Clock } from '../domain/clock';
import type { FaultPlan } from '../domain/faults/fault-plan';
import { NO_FAULTS } from '../domain/faults/fault-plan';
import type { SessionStore, SignInRequest } from '../domain/gateway/sessions';
import { SESSION_COOKIE_NAME, createSessionStore } from '../domain/gateway/sessions';
import type { Random } from '../domain/random';
import type { RateLimiter } from '../domain/rate-limit/rate-limiter';
import type { EngineRuntime } from '../domain/state/engine-runtime';
import { createEngineRuntime } from '../domain/state/engine-runtime';
import type { SimulationMode } from '../domain/simulation/simulation-clock';
import { capabilitiesFor, FULL_CAPABILITY_NAMES } from '../domain/state/capabilities';
import type { MockCapabilityName } from '../domain/state/capabilities';
import type { Scenario } from '../domain/state/scenarios';
import type { BundleStore } from '../domain/ui/bundle-store';
import type { UiLoader } from '../domain/ui/ui-loader';
import { loadGatewayPageFiles } from '../adapters/http/gateway-page-files';
import { ENGINE_COMMAND } from '../app/registration-messages';
import type { PasskeyCeremonies } from '../domain/gateway/passkey-ceremonies';
import { createChallenges } from '../domain/gateway/passkey-ceremonies';
import type { PasskeyGateway, PasskeyStore } from '../domain/gateway/passkey-gateway';
import { createInMemoryPasskeyStore, createPasskeyGateway } from '../domain/gateway/passkey-gateway';
import { hasOwner } from '../domain/onboarding/owner';
import type { SetupSecrets } from '../domain/onboarding/setup-secret';
import { createInMemorySetupSecretStore, createSetupSecrets } from '../domain/onboarding/setup-secret';
import type { ContractRecorder } from './contract-recorder';
import type { FakeCeremonies } from './fake-passkey-ceremonies';
import { createFakeCeremonies } from './fake-passkey-ceremonies';
import { createContractRecorder } from './contract-recorder';
import {
    HARNESS_CANARY,
    HARNESS_CLIENT_IP,
    HARNESS_DOMAIN,
    HARNESS_ENGINE_ID,
    HARNESS_HOSTNAME,
} from './engine-harness';
import type { MemoryLogger } from './memory-logger';
import { createMemoryLogger } from './memory-logger';
import { asBrowser, createNodeFetch } from './node-fetch';

export const HARNESS_ORIGIN = `https://${HARNESS_HOSTNAME}`;
export const HARNESS_EPOCH = new Date('2026-10-01T00:00:00Z');

export interface ApiHarnessOptions {
    /** Serve this core instead of a seeded runtime (the shared client suite brings its own). */
    readonly core?: InMemoryEngineCore;
    readonly scenario?: Scenario;
    readonly seed?: number;
    readonly clock?: Clock;
    readonly random?: Random;
    readonly devLogin?: boolean;
    readonly faults?: FaultPlan;
    readonly rateLimiter?: RateLimiter;
    /** The UI bundles the app's routes serve; without it they answer 503. */
    readonly bundles?: Pick<BundleStore, 'active' | 'read'>;
    /** The UI loader the control listener drives. */
    readonly ui?: UiLoader;
    /** What `GET /engine` advertises; every C-07 capability by default. */
    readonly capabilities?: readonly MockCapabilityName[];
    /** Paused by default, so nothing changes unless a test advances the simulation clock. */
    readonly simulation?: { readonly mode: SimulationMode; readonly speed: number };
    /** The epoch seeded data lies before, and where a paused simulation's time starts. */
    readonly epoch?: Date;
    /** Serve `/setup` and the passkey pages, with in-memory stores and a fake WebAuthn unless given a real one. */
    readonly onboarding?: { readonly ceremonies?: PasskeyCeremonies };
    /** `MOCK_PASSKEYS`; `none` by default with onboarding, so the setup link works. */
    readonly passkeys?: 'seeded' | 'none';
    /** `MOCK_LIVE_BROWSER`: off by default, as in a started mock. */
    readonly liveBrowser?: boolean;
    /** `MOCK_VOICE`: off by default, as in a started mock. */
    readonly voice?: boolean;
}

/** The onboarding side of the harness, for tests that drive the setup link and passkeys. */
export interface HarnessOnboarding {
    readonly secrets: SetupSecrets;
    readonly gateway: PasskeyGateway;
    readonly passkeys: PasskeyStore;
    /** The fake WebAuthn, unless the test gave a real one. */
    readonly ceremonies: FakeCeremonies;
    /** A fresh setup secret, as `setup-link` would print it. */
    issue(): Promise<string>;
}

export interface ApiHarness {
    readonly server: EngineServer;
    readonly runtime: EngineRuntime | null;
    readonly sessions: SessionStore;
    readonly faults: FaultSettings;
    readonly recorder: ContractRecorder;
    readonly logger: MemoryLogger;
    /** Present with the `onboarding` option. */
    readonly onboarding: HarnessOnboarding | null;
    core(): InMemoryEngineCore;
    /** A session through the gateway's own store, as `/__mock/sessions` creates one; returns the `Cookie` value. */
    signIn(
        request: Omit<SignInRequest, 'client' | 'permissions'> & Partial<Pick<SignInRequest, 'permissions'>>,
    ): string;
    /** The owner's member ID in the seeded runtime. */
    ownerId(): string;
    /** A TLS connection over a fresh duplex pair, as one tunnel stream from `clientIp`. */
    openSocket(clientIp?: string): TLSSocket;
    /** Requests from a browser on the engine's origin (cookie and Fetch Metadata), recorded. */
    fetch(cookie: string | null, clientIp?: string): typeof fetch;
    /** The same without browser headers, for tests that set them by hand. */
    rawFetch(clientIp?: string): typeof fetch;
    client(cookie: string | null): EngineApiClient;
    /** Starts the control listener on a loopback port. */
    startControl(): Promise<ControlServer>;
    close(): Promise<void>;
}

async function harnessOnboarding(
    options: NonNullable<ApiHarnessOptions['onboarding']>,
    deps: {
        readonly core: () => InMemoryEngineCore;
        readonly sessions: SessionStore;
        readonly clock: Clock;
        readonly random: Random;
        readonly logger: MemoryLogger;
    },
): Promise<HarnessOnboarding> {
    const fake = createFakeCeremonies();
    const secrets = createSetupSecrets({
        store: createInMemorySetupSecretStore(),
        random: deps.random,
        clock: deps.clock,
        hasOwner: () => hasOwner(deps.core().controller.inspect()),
    });
    const passkeys = createInMemoryPasskeyStore();
    const gateway = createPasskeyGateway({
        engine: () => deps.core().controller,
        sessions: deps.sessions,
        secrets,
        passkeys,
        ceremonies: options.ceremonies ?? fake,
        challenges: createChallenges({ random: deps.random, clock: deps.clock }),
        random: deps.random,
        clock: deps.clock,
        logger: deps.logger,
    });
    await gateway.restore();
    return {
        secrets,
        gateway,
        passkeys,
        ceremonies: fake,
        async issue() {
            const issued = await secrets.issue();
            if (issued.kind !== 'issued') throw new Error(`no setup secret: ${issued.kind}`);
            return issued.secret.reveal();
        },
    };
}

const systemClock: Clock = {
    nowMs: () => Date.now(),
    setTimeout(fn, ms) {
        const timer = setTimeout(fn, ms);
        return () => {
            clearTimeout(timer);
        };
    },
};

/**
 * The mock engine's whole in-tunnel server (gateway, engine API, faults, throttle) without a relay: every request is
 * real HTTP/1.1 over TLS with the dev CA, over a duplex pair standing in for a tunnel stream.
 */
export async function createApiHarness(options: ApiHarnessOptions = {}): Promise<ApiHarness> {
    const clock = options.clock ?? systemClock;
    const logger = createMemoryLogger();
    const faults = createFaultSettings(options.faults ?? NO_FAULTS);
    const runtime =
        options.core === undefined
            ? await createEngineRuntime({
                  seed: options.seed ?? 42,
                  scenario: options.scenario ?? 'small-team',
                  epoch: options.epoch ?? HARNESS_EPOCH,
                  identity: {
                      engineId: HARNESS_ENGINE_ID,
                      hostname: HARNESS_HOSTNAME,
                      mode: 'tunnel',
                      version: '0.1.0',
                  },
                  clock,
                  capabilities: capabilitiesFor(options.capabilities ?? FULL_CAPABILITY_NAMES),
                  simulation: options.simulation ?? { mode: 'paused', speed: 1 },
                  passkeys: options.passkeys ?? (options.onboarding === undefined ? 'seeded' : 'none'),
                  liveBrowser: options.liveBrowser ?? false,
                  voice: options.voice ?? false,
                  faults: () => faults.plan(),
                  onSimulationError: (error) => {
                      logger.error('simulation.error', { problem: error instanceof Error ? error.message : 'unknown' });
                  },
              })
            : null;
    const core = (): InMemoryEngineCore => runtime?.core() ?? (options.core as InMemoryEngineCore);
    const sessions = createSessionStore({
        engine: () => core().controller,
        clock,
        random: options.random ?? createCryptoRandom(),
    });
    runtime?.onReset(() => {
        sessions.clear();
    });
    const onboarding =
        options.onboarding === undefined
            ? null
            : await harnessOnboarding(options.onboarding, {
                  core,
                  sessions,
                  clock,
                  random: options.random ?? createCryptoRandom(),
                  logger,
              });
    const ca = createDevCa([HARNESS_DOMAIN], clock);
    const certificates = createDevCaCertificateSource({ ca, clock, logger });
    certificates.addHostnames([HARNESS_HOSTNAME]);
    const server = createEngineServer({
        engineId: HARNESS_ENGINE_ID,
        certificates,
        core,
        ...(runtime === null ? {} : { microphone: () => supports(runtime.current(), KNOWN_CAPABILITIES.voiceInput) }),
        sessions,
        faults,
        seed: options.seed ?? 42,
        devLogin: options.devLogin ?? false,
        canary: HARNESS_CANARY,
        clock,
        logger,
        ...(options.rateLimiter === undefined ? {} : { rateLimiter: options.rateLimiter }),
        ...(options.bundles === undefined ? {} : { bundles: options.bundles }),
        ...(onboarding === null
            ? {}
            : {
                  passkeys: {
                      gateway: onboarding.gateway,
                      files: await loadGatewayPageFiles(),
                      ownerSetUp: () => hasOwner(core().controller.inspect()),
                      command: ENGINE_COMMAND,
                  },
              }),
    });
    const recorder = createContractRecorder();
    const sockets = new Set<TLSSocket>();
    const controls: ControlServer[] = [];

    function openSocket(clientIp = HARNESS_CLIENT_IP): TLSSocket {
        const [client, serverEnd] = duplexPair();
        client.once('close', () => serverEnd.destroy());
        serverEnd.once('close', () => client.destroy());
        server.handle(serverEnd, { family: 'IPv4', address: clientIp, port: 50_000 });
        const socket = connect({
            socket: client,
            ca: ca.certificatePem,
            servername: HARNESS_HOSTNAME,
            ALPNProtocols: ['http/1.1'],
            checkServerIdentity: (_host, certificate) => checkServerIdentity(HARNESS_HOSTNAME, certificate),
        });
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        return socket;
    }

    const rawFetch = (clientIp?: string): typeof fetch =>
        recorder.wrap(createNodeFetch({ connect: () => openSocket(clientIp), host: HARNESS_HOSTNAME }));
    const browserFetch = (cookie: string | null, clientIp?: string): typeof fetch =>
        asBrowser(rawFetch(clientIp), HARNESS_ORIGIN, () => cookie);

    return {
        server,
        runtime,
        sessions,
        faults,
        recorder,
        logger,
        onboarding,
        core,
        signIn(request) {
            const { token } = sessions.signIn({
                permissions: null,
                ...request,
                client: { ip: HARNESS_CLIENT_IP, userAgent: 'api harness' },
            });
            return `${SESSION_COOKIE_NAME}=${token}`;
        },
        ownerId() {
            const owner = core()
                .controller.inspect()
                .members.find(({ role }) => role === 'owner');
            if (owner === undefined) throw new Error('no owner');
            return owner.id;
        },
        openSocket,
        fetch: browserFetch,
        rawFetch,
        client: (cookie) =>
            createFetchEngineApiClient({ baseUrl: HARNESS_ORIGIN, fetch: browserFetch(cookie), timeoutMs: 10_000 }),
        async startControl() {
            if (runtime === null) throw new Error('the control listener needs a seeded runtime');
            const control = await startControlServer({
                host: '127.0.0.1',
                port: 0,
                runtime,
                sessions,
                faults,
                rateLimiter: { consume: () => ({ kind: 'allowed' }) },
                ...(options.ui === undefined ? {} : { ui: options.ui }),
                logger,
                now: () => new Date(clock.nowMs()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
            });
            controls.push(control);
            return control;
        },
        async close() {
            runtime?.simulation().stop();
            for (const socket of [...sockets]) socket.destroy();
            server.close();
            certificates.close();
            await Promise.all(controls.map((control) => control.close()));
        },
    };
}
