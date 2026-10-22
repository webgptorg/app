/*
 * The engine the UI flows (X-04) run against, as a port: the mock engine today, the real engine in E-03. Specs reach
 * the engine only through this interface and the browser; `mock-engine-target.ts` is the one file that knows the mock's
 * control listener. A control a target lacks makes the flows that need it skip with a reason, so the same suite runs
 * against an engine that offers none of them.
 */
import type { Permission, Role } from '@ptbk/engine-api';

/** Who a session is for. The owner holds every permission; a permission set is a member holding exactly that set. */
export type UiSessionSubject =
    | { readonly kind: 'owner' }
    | { readonly kind: 'member'; readonly role: Role }
    | { readonly kind: 'member'; readonly permissions: readonly Permission[] };

/** A gateway session cookie for the engine's hostname, set into the browser context as the gateway would set it. */
export interface SessionCookie {
    readonly name: string;
    readonly value: string;
}

export type EngineScenario = 'empty' | 'small-team' | 'large-fleet';
export type EngineCapabilityName = 'runs' | 'files' | 'triggers' | 'integrations';

export const ALL_CAPABILITIES: readonly EngineCapabilityName[] = ['runs', 'files', 'triggers', 'integrations'];

export interface ResetOptions {
    readonly scenario: EngineScenario;
    readonly seed: number;
    readonly capabilities: readonly EngineCapabilityName[];
}

/** Faults injected into the engine's answers; absent fields are off. */
export interface FaultPlan {
    readonly latencyMs?: { readonly min: number; readonly max: number };
    readonly errorRate?: number;
    readonly errorStatus?: 500 | 502 | 503;
    readonly dropStreamRate?: number;
    readonly slowTunnelBytesPerS?: number;
    readonly scanInfectedRate?: number;
    readonly integrationErrorRate?: number;
    /** Request-path globs the faults apply to: `*` within one segment, `**` across segments. */
    readonly routes?: readonly string[];
}

export interface FaultControl {
    set(plan: FaultPlan): Promise<void>;
    clear(): Promise<void>;
}

export interface ScriptedRunInput {
    readonly agentId: string;
    readonly outcome: 'completed' | 'failed';
    readonly steps: readonly { readonly text: string; readonly toolName?: string }[];
}

/** What a UI update check decided about a tampered release, and which bundle is served afterwards. */
export interface TamperOutcome {
    readonly refused: boolean;
    readonly reason: string | null;
    readonly activeVersion: string | null;
}

export interface LastHeartbeat {
    readonly sentAt: string;
    /** Exactly the bytes the engine sent. */
    readonly body: string;
}

/**
 * Test-only levers. Each is optional: the real engine offers none of them, and a flow that needs one skips there.
 * Time-dependent flows pause the simulation and advance it explicitly, never sleep.
 */
export interface EngineControls {
    /** A fresh engine state from a seed; every session ends. */
    readonly reset?: (options: ResetOptions) => Promise<void>;
    readonly faults?: FaultControl;
    /** Stops engine time; it then moves only through `advanceTime`. */
    readonly pauseSimulation?: () => Promise<void>;
    readonly advanceTime?: (ms: number) => Promise<void>;
    /** Queues a run that makes one transition per simulated second; answers its ID. */
    readonly scriptRun?: (input: ScriptedRunInput) => Promise<{ readonly runId: string }>;
    /** An email arriving for an email trigger; answers the run it started, if any. */
    readonly inboundEmail?: (input: {
        readonly triggerId: string;
        readonly from: string;
        readonly subject: string;
    }) => Promise<{ readonly runId: string | null }>;
    /** Publishes a release whose archive changed after signing and has the engine check it now. */
    readonly tamperBundle?: () => Promise<TamperOutcome>;
    /** What the engine last sent to the dashboard, or `null` before the first heartbeat. */
    readonly lastHeartbeat?: () => Promise<LastHeartbeat | null>;
}

export interface EngineTarget {
    /** The engine's hostname; the browser reaches it only through the relays. */
    readonly hostname: string;
    session(subject: UiSessionSubject): Promise<SessionCookie>;
    readonly controls: EngineControls;
}
