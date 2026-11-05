import { NO_FAULTS } from '../domain/faults/fault-plan';
import type { EngineRuntime, EngineRuntimeOptions } from '../domain/state/engine-runtime';
import { createEngineRuntime } from '../domain/state/engine-runtime';
import { capabilitiesFor, FULL_CAPABILITY_NAMES } from '../domain/state/capabilities';

/** A runtime with every capability, no faults and a paused simulation, unless the test says otherwise. */
export function createTestRuntime(
    options: Omit<EngineRuntimeOptions, 'capabilities' | 'simulation' | 'faults' | 'onSimulationError'> &
        Partial<EngineRuntimeOptions>,
): Promise<EngineRuntime> {
    return createEngineRuntime({
        capabilities: capabilitiesFor(FULL_CAPABILITY_NAMES),
        simulation: { mode: 'paused', speed: 1 },
        faults: () => NO_FAULTS,
        onSimulationError: (error) => {
            throw error;
        },
        ...options,
    });
}
