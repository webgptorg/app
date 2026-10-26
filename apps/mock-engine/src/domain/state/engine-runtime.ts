import type { CapabilityRef, SecurityOverview, UiUpdateCheck } from '@ptbk/engine-api';
import { createInMemoryEngineCore } from '@ptbk/engine-api/in-memory';
import type { InMemoryEngineController, InMemoryEngineCore, ReplyScript, Sleep } from '@ptbk/engine-api/in-memory';

import { decideOwnership } from '../authorization/policy';
import { generateReply } from '../chat/reply-generator';
import type { Clock } from '../clock';
import { createEngineChecks } from '../faults/engine-checks';
import type { FaultPlan } from '../faults/fault-plan';
import type { Simulation } from '../simulation/simulation';
import { createSimulation } from '../simulation/simulation';
import type { SimulationClock, SimulationMode } from '../simulation/simulation-clock';
import { createSimulationClock } from '../simulation/simulation-clock';
import { MOCK_UPLOAD_POLICIES } from './capabilities';
import type { Scenario } from './scenarios';
import { HOSTILE_AGENT_NAME, ownerOf, seedEngine } from './seed';
import { createSeededSequence, hashSeed } from './seed-random';

type RelayStatus = SecurityOverview['relays'][number]['status'];

/** What the heartbeat loop knows (M-06): the last beat exactly as sent, and the clock skew the dashboard reported. */
export interface HeartbeatInfo {
    readonly lastHeartbeat: { readonly sentAt: string; readonly body: string; readonly signature: string } | null;
    readonly clockSkew: { readonly seconds: number; readonly measuredAt: string } | null;
}

/** The security panel's `ui`: the active bundle's version, archive SHA-256 and release log index. */
export interface UiBundleInfo {
    readonly version: string;
    readonly bundleSha256: string;
    readonly releaseLogIndex: number | null;
}

/** The security panel's `tls`: the certificate the engine serves for its default hostname right now. */
export interface TlsCertificateInfo {
    /** SHA-256 of the leaf's DER, lowercase hex. */
    readonly certificateSha256: string;
    readonly notAfter: string;
}

export interface EngineIdentityInfo {
    readonly engineId: string;
    /** `<engineId>.<engine domain>`. */
    readonly hostname: string;
    readonly mode: 'tunnel' | 'direct' | 'local';
    readonly version: string;
}

export interface EngineRuntimeOptions {
    readonly seed: number;
    readonly scenario: Scenario;
    readonly epoch: Date;
    readonly identity: EngineIdentityInfo;
    /** The real clock: replies are paced on it, and the simulation's time is derived from it. */
    readonly clock: Clock;
    /** What `GET /engine` advertises (`MOCK_CAPABILITIES`). */
    readonly capabilities: readonly CapabilityRef[];
    /** `MOCK_SIMULATION` and `MOCK_SIMULATION_SPEED`. */
    readonly simulation: { readonly mode: SimulationMode; readonly speed: number };
    readonly faults: () => FaultPlan;
    /** Unexpected errors inside the simulation; it carries on. */
    readonly onSimulationError: (error: unknown) => void;
}

export interface ResetInput {
    readonly seed: number;
    readonly scenario: Scenario;
    /** Keeps the current capabilities when absent. */
    readonly capabilities?: readonly CapabilityRef[];
}

export interface EngineRuntime {
    /** The current core; `reset` replaces it, so callers ask on every request. */
    core(): InMemoryEngineCore;
    controller(): InMemoryEngineController;
    current(): {
        readonly seed: number;
        readonly scenario: Scenario;
        readonly capabilities: readonly CapabilityRef[];
    };
    /** The live simulation on the current core; `reset` replaces it too. */
    simulation(): Simulation;
    /** The engine's time, shared by every core this runtime builds. */
    readonly clock: SimulationClock;
    /**
     * A new core from a new seed, with what the process reported so far applied again. The engine's time starts again
     * at the seed epoch while the simulation is paused (so a paused run is reproducible), and at the real time while it
     * runs.
     */
    reset(input: ResetInput): Promise<void>;
    /** Runs after every reset, e.g. to drop the gateway's sessions, which the new core does not list. */
    onReset(listener: () => void): void;
    setDashboardUrl(url: string | null): void;
    setRelayStatus(relayHostname: string, status: RelayStatus): void;
    setHostnames(hostnames: readonly string[]): void;
    setHeartbeat(heartbeat: HeartbeatInfo): void;
    /** The UI bundle the loader serves (M-05); `null` once none is, as before the first install. */
    setUi(ui: UiBundleInfo | null): void;
    /** The UI loader's last update check (M-05). */
    setUiUpdateCheck(check: UiUpdateCheck): void;
    /** The certificate served for the default hostname, after every issue or renewal. */
    setTlsCertificate(certificate: TlsCertificateInfo): void;
}

function clockSleep(clock: Clock): Sleep {
    return (ms, signal) =>
        new Promise((resolve, reject) => {
            if (signal.aborted) {
                reject(signal.reason as Error);
                return;
            }
            const abort = (): void => {
                cancel();
                reject(signal.reason as Error);
            };
            const cancel = clock.setTimeout(() => {
                signal.removeEventListener('abort', abort);
                resolve();
            }, ms);
            signal.addEventListener('abort', abort, { once: true });
        });
}

/**
 * The engine's state as one in-memory core from `@ptbk/engine-api`, seeded from (seed, scenario, epoch), with the
 * mock's policy (ownership on top of permissions), reply generator, fault-driven scans and connection tests, and the
 * live simulation. The core's timestamps come from the simulation clock; replies are paced in real time, so chat keeps
 * working while the simulation is paused.
 */
export async function createEngineRuntime(options: EngineRuntimeOptions): Promise<EngineRuntime> {
    const { identity, clock } = options;
    const startMs = (mode: SimulationMode): number => (mode === 'paused' ? options.epoch.getTime() : clock.nowMs());
    const simulationClock = createSimulationClock({
        real: clock,
        mode: options.simulation.mode,
        speed: options.simulation.speed,
        startMs: startMs(options.simulation.mode),
    });
    const sticky = {
        dashboardUrl: null as string | null,
        relays: new Map<string, { readonly status: RelayStatus; readonly since: string }>(),
        hostnames: [identity.hostname] as readonly string[],
        heartbeat: { lastHeartbeat: null, clockSkew: null } as HeartbeatInfo,
        ui: null as UiBundleInfo | null,
        uiUpdateCheck: null as UiUpdateCheck | null,
        tls: null as TlsCertificateInfo | null,
    };
    // Each core's own placeholder, so it comes back when a revocation leaves no bundle active.
    const placeholderUi = new WeakMap<InMemoryEngineCore, SecurityOverview['ui']>();
    const listeners: (() => void)[] = [];
    let current = { seed: options.seed, scenario: options.scenario, capabilities: options.capabilities };
    const now = (): string => new Date(clock.nowMs()).toISOString().replace(/\.\d{3}Z$/, 'Z');

    async function build(
        seedValue: number,
        scenario: Scenario,
        capabilities: readonly CapabilityRef[],
    ): Promise<{ readonly core: InMemoryEngineCore; readonly simulation: Simulation }> {
        const seed = await seedEngine({ seed: seedValue, scenario, epoch: options.epoch, hostname: identity.hostname });
        const replyScript: ReplyScript = ({ agent, content, chatId, messageIndex }) => ({
            chunks: generateReply({
                seed: seedValue,
                chatId,
                messageIndex,
                agentName: agent.name,
                content,
                hostile: agent.name === HOSTILE_AGENT_NAME,
            }).chunks,
        });
        const core = createInMemoryEngineCore({
            seed: {
                ...seed,
                engine: {
                    engineId: identity.engineId,
                    name: seed.settings?.name ?? 'Mock engine',
                    hostname: identity.hostname,
                    dashboardUrl: sticky.dashboardUrl,
                    mode: identity.mode,
                },
            },
            clock: { now: () => new Date(simulationClock.nowMs()) },
            member: { id: ownerOf(seed), role: 'owner' },
            replyScript,
            capabilities,
            authorizer: { can: decideOwnership },
            uploadPolicies: MOCK_UPLOAD_POLICIES,
            sleep: clockSleep(clock),
            checks: createEngineChecks({
                faults: options.faults,
                scans: createSeededSequence(hashSeed(seedValue, scenario, 'scans')),
                probes: createSeededSequence(hashSeed(seedValue, scenario, 'probes')),
            }),
        });
        core.controller.updateSecurity({
            engine: { version: identity.version, releaseLogIndex: null },
            update: {
                status: 'none',
                policy: seed.settings?.updatePolicy.policy ?? 'auto',
                pinnedVersion: seed.settings?.updatePolicy.pinnedVersion ?? null,
                availableVersion: null,
                eligibleAt: null,
            },
        });
        applySecurity(core);
        const simulation = createSimulation({
            controller: core.controller,
            clock: simulationClock,
            seed: seedValue,
            scenario,
            faults: options.faults,
            onError: options.onSimulationError,
        });
        return { core, simulation };
    }

    /** Only the default hostname's certificate is tracked (`setTlsCertificate`); custom ones stay unreported. */
    function defaultCertificateStatus(): 'valid' | 'expired' | null {
        if (sticky.tls === null) return null;
        return Date.parse(sticky.tls.notAfter) > clock.nowMs() ? 'valid' : 'expired';
    }

    function applySecurity(core: InMemoryEngineCore): void {
        // Until a bundle is active the core's placeholder bundle stays, but a refused or failed check still shows.
        const overview = core.controller.updateSecurity({});
        if (!placeholderUi.has(core)) placeholderUi.set(core, overview.ui);
        const ui = sticky.ui ?? placeholderUi.get(core) ?? overview.ui;
        core.controller.updateSecurity({
            ...(sticky.tls === null ? {} : { tls: { ...overview.tls, ...sticky.tls } }),
            ui: { ...ui, lastUpdateCheck: sticky.uiUpdateCheck },
            lastHeartbeat: sticky.heartbeat.lastHeartbeat,
            clockSkew: sticky.heartbeat.clockSkew,
            relays: [...sticky.relays].map(([hostname, relay]) => ({ hostname, ...relay })),
            hostnames: sticky.hostnames.map((hostname, index) =>
                index === 0
                    ? { hostname, kind: 'default' as const, certificateStatus: defaultCertificateStatus() }
                    : { hostname, kind: 'custom' as const },
            ),
        });
    }

    let engine = await build(current.seed, current.scenario, current.capabilities);
    let resetting: Promise<unknown> = Promise.resolve();

    return {
        core: () => engine.core,
        controller: () => engine.core.controller,
        current: () => current,
        simulation: () => engine.simulation,
        clock: simulationClock,
        reset(input) {
            // One at a time: two overlapping resets would each build a core, and the loser's simulation would run on.
            const next = resetting.then(async () => {
                const capabilities = input.capabilities ?? current.capabilities;
                engine.simulation.stop();
                simulationClock.reset(startMs(simulationClock.mode()));
                engine = await build(input.seed, input.scenario, capabilities);
                current = { seed: input.seed, scenario: input.scenario, capabilities };
                for (const listener of listeners) listener();
            });
            resetting = next.catch(() => undefined);
            return next;
        },
        onReset(listener) {
            listeners.push(listener);
        },
        setDashboardUrl(url) {
            sticky.dashboardUrl = url;
            engine.core.controller.updateEngine({ dashboardUrl: url });
        },
        setRelayStatus(relayHostname, status) {
            if (sticky.relays.get(relayHostname)?.status === status) return;
            sticky.relays.set(relayHostname, { status, since: now() });
            applySecurity(engine.core);
        },
        setHeartbeat(heartbeat) {
            sticky.heartbeat = heartbeat;
            applySecurity(engine.core);
        },
        setUi(ui) {
            sticky.ui = ui;
            applySecurity(engine.core);
        },
        setUiUpdateCheck(check) {
            sticky.uiUpdateCheck = check;
            applySecurity(engine.core);
        },
        setTlsCertificate(certificate) {
            sticky.tls = certificate;
            applySecurity(engine.core);
        },
        setHostnames(hostnames) {
            sticky.hostnames = [identity.hostname, ...hostnames.filter((name) => name !== identity.hostname)];
            applySecurity(engine.core);
        },
    };
}
