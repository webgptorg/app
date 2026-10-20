import type { SecurityOverview } from '@ptbk/engine-api';
import { createInMemoryEngineCore } from '@ptbk/engine-api/in-memory';
import type { InMemoryEngineController, InMemoryEngineCore, ReplyScript, Sleep } from '@ptbk/engine-api/in-memory';

import { decideOwnership } from '../authorization/policy';
import { generateReply } from '../chat/reply-generator';
import type { Clock } from '../clock';
import type { Scenario } from './scenarios';
import { HOSTILE_AGENT_NAME, ownerOf, seedEngine } from './seed';

type RelayStatus = SecurityOverview['relays'][number]['status'];

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
    readonly clock: Clock;
}

export interface EngineRuntime {
    /** The current core; `reset` replaces it, so callers ask on every request. */
    core(): InMemoryEngineCore;
    controller(): InMemoryEngineController;
    current(): { readonly seed: number; readonly scenario: Scenario };
    /** A new core from a new seed, with what the process reported so far applied again. */
    reset(input: { readonly seed: number; readonly scenario: Scenario }): void;
    /** Runs after every reset, e.g. to drop the gateway's sessions, which the new core does not list. */
    onReset(listener: () => void): void;
    setDashboardUrl(url: string | null): void;
    setRelayStatus(relayHostname: string, status: RelayStatus): void;
    setHostnames(hostnames: readonly string[]): void;
    /** The heartbeat the engine last sent, exactly as sent (M-06 reports it). */
    setLastHeartbeat(heartbeat: SecurityOverview['lastHeartbeat']): void;
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
 * mock's policy (ownership on top of permissions) and reply generator. Capabilities are off until M-07.
 */
export function createEngineRuntime(options: EngineRuntimeOptions): EngineRuntime {
    const { identity, clock } = options;
    const sticky = {
        dashboardUrl: null as string | null,
        relays: new Map<string, { readonly status: RelayStatus; readonly since: string }>(),
        hostnames: [identity.hostname] as readonly string[],
        lastHeartbeat: null as SecurityOverview['lastHeartbeat'],
    };
    const listeners: (() => void)[] = [];
    let current = { seed: options.seed, scenario: options.scenario };
    const now = (): string => new Date(clock.nowMs()).toISOString().replace(/\.\d{3}Z$/, 'Z');

    function build(seedValue: number, scenario: Scenario): InMemoryEngineCore {
        const seed = seedEngine({ seed: seedValue, scenario, epoch: options.epoch });
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
            clock: { now: () => new Date(clock.nowMs()) },
            member: { id: ownerOf(seed), role: 'owner' },
            replyScript,
            capabilities: [],
            authorizer: { can: decideOwnership },
            sleep: clockSleep(clock),
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
        return core;
    }

    function applySecurity(core: InMemoryEngineCore): void {
        core.controller.updateSecurity({
            lastHeartbeat: sticky.lastHeartbeat,
            relays: [...sticky.relays].map(([hostname, relay]) => ({ hostname, ...relay })),
            hostnames: sticky.hostnames.map((hostname, index) => ({
                hostname,
                kind: index === 0 ? ('default' as const) : ('custom' as const),
            })),
        });
    }

    let core = build(current.seed, current.scenario);

    return {
        core: () => core,
        controller: () => core.controller,
        current: () => current,
        reset(input) {
            core = build(input.seed, input.scenario);
            current = { seed: input.seed, scenario: input.scenario };
            for (const listener of listeners) listener();
        },
        onReset(listener) {
            listeners.push(listener);
        },
        setDashboardUrl(url) {
            sticky.dashboardUrl = url;
            core.controller.updateEngine({ dashboardUrl: url });
        },
        setRelayStatus(relayHostname, status) {
            if (sticky.relays.get(relayHostname)?.status === status) return;
            sticky.relays.set(relayHostname, { status, since: now() });
            applySecurity(core);
        },
        setLastHeartbeat(heartbeat) {
            sticky.lastHeartbeat = heartbeat;
            applySecurity(core);
        },
        setHostnames(hostnames) {
            sticky.hostnames = [identity.hostname, ...hostnames.filter((name) => name !== identity.hostname)];
            applySecurity(core);
        },
    };
}
