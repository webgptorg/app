import type { Bytes, EngineId, RegisterEngineRequest, RegisterEngineResponse, Timestamp } from '@ptbk/protocol';

/** The parts of a dashboard problem+json the engine acts on, read tolerantly. */
export interface DashboardProblem {
    readonly code: string;
    /** Only on a stale heartbeat timestamp: the dashboard's clock. */
    readonly serverTime: Timestamp | null;
}

export type RegisterCall =
    | { readonly kind: 'ok'; readonly response: RegisterEngineResponse }
    | { readonly kind: 'problem'; readonly status: number; readonly problem: DashboardProblem }
    /** A success status with a body that is not a registration response (or is over the size cap). */
    | { readonly kind: 'invalid-response'; readonly status: number }
    /** No answer, a timeout, or an error status without a readable problem; `status` is null without an answer. */
    | { readonly kind: 'unavailable'; readonly status: number | null };

export type HeartbeatCall =
    /** `revocations`: the signed member revocations a v2 reply carried, unverified; none for v1. */
    | { readonly kind: 'accepted'; readonly status: number; readonly revocations: readonly string[] }
    | { readonly kind: 'refused'; readonly status: number; readonly problem: DashboardProblem | null }
    | { readonly kind: 'unavailable' };

/**
 * The engine's only conversation with our platform: one registration, then heartbeats, whose v2 reply may carry member
 * revocations. Both go straight to the dashboard over HTTPS, never through a relay.
 */
export interface DashboardApi {
    register(request: RegisterEngineRequest, signal: AbortSignal): Promise<RegisterCall>;
    /** Sends `rawBody` exactly as given: the signature covers these bytes. */
    heartbeat(engineId: EngineId, rawBody: Bytes, signature: string, signal: AbortSignal): Promise<HeartbeatCall>;
}
