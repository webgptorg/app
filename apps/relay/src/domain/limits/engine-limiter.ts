import type { EngineId } from '@ptbk/protocol';

import type { Clock } from '../clock';
import type { TokenBucket } from './token-bucket';
import { createTokenBucket } from './token-bucket';

export interface EngineLimits {
    /** `RELAY_MAX_STREAMS_PER_ENGINE`: open browser streams. */
    readonly maxStreams: number;
    /** `RELAY_NEW_STREAMS_PER_ENGINE_PER_S`; also the burst. */
    readonly newStreamsPerS: number;
    /** `RELAY_ENGINE_BANDWIDTH_BYTES_PER_S`, both directions together; one second's worth is the burst. */
    readonly bandwidthBytesPerS: number;
}

export type EngineRefusal = 'engine-streams' | 'engine-rate';

export type StreamAdmission =
    | { readonly kind: 'admitted'; /** Idempotent. */ release(): void }
    | { readonly kind: 'refused'; readonly reason: EngineRefusal };

/**
 * Fairness between engines on one relay (spec, Fairness and DoS): one customer, or an attack on one, cannot take the
 * streams or bandwidth of the others. Keyed by engine, so a replacement tunnel inherits its predecessor's budget.
 */
export interface EngineLimiter {
    admitStream(engineId: EngineId): StreamAdmission;
    /** Charges `bytes` relayed for the engine; returns how many milliseconds its traffic should pause (0: none). */
    throttle(engineId: EngineId, bytes: number): number;
    trackedEngines(): number;
}

interface EngineState {
    open: number;
    readonly streams: TokenBucket;
    readonly bandwidth: TokenBucket;
}

const MIN_SWEEP_AT = 1024;

export function createEngineLimiter(limits: EngineLimits, clock: Clock): EngineLimiter {
    const states = new Map<EngineId, EngineState>();
    let sweepAt = MIN_SWEEP_AT;

    function stateOf(engineId: EngineId): EngineState {
        let state = states.get(engineId);
        if (state === undefined) {
            if (states.size >= sweepAt) {
                for (const [id, idle] of states) {
                    if (idle.open === 0 && idle.streams.isFull() && idle.bandwidth.isFull()) states.delete(id);
                }
                sweepAt = Math.max(MIN_SWEEP_AT, states.size * 2);
            }
            const { newStreamsPerS, bandwidthBytesPerS } = limits;
            state = {
                open: 0,
                streams: createTokenBucket({ capacity: newStreamsPerS, refillPerSecond: newStreamsPerS, clock }),
                bandwidth: createTokenBucket({
                    capacity: bandwidthBytesPerS,
                    refillPerSecond: bandwidthBytesPerS,
                    clock,
                }),
            };
            states.set(engineId, state);
        }
        return state;
    }

    return {
        admitStream(engineId) {
            const state = stateOf(engineId);
            if (state.open >= limits.maxStreams) return { kind: 'refused', reason: 'engine-streams' };
            if (!state.streams.tryTake(1)) return { kind: 'refused', reason: 'engine-rate' };
            state.open++;
            let released = false;
            return {
                kind: 'admitted',
                release() {
                    if (released) return;
                    released = true;
                    state.open--;
                },
            };
        },
        throttle: (engineId, bytes) => stateOf(engineId).bandwidth.takeOrWait(bytes),
        trackedEngines: () => states.size,
    };
}
