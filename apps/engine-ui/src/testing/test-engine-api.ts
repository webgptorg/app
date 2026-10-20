import { createProblem } from '@ptbk/engine-api';
import type { EngineApiClient, EngineApiResponse, ProblemCode } from '@ptbk/engine-api';
import { createInMemoryEngineApiClient } from '@ptbk/engine-api/in-memory';
import type { InMemoryEngineApiOptions } from '@ptbk/engine-api/in-memory';

export const TEST_NOW = new Date('2026-10-01T12:00:00.000Z');

/** The in-memory engine API with a fixed clock and a small default seed; pass options to replace either. */
export function createTestEngineApi(options: InMemoryEngineApiOptions = {}): EngineApiClient {
    return createInMemoryEngineApiClient({
        clock: { now: () => TEST_NOW },
        seed: {
            engine: { name: 'Test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
            agents: [{ source: 'Ada\nPERSONA Research' }, { source: 'Grace\nPERSONA Review' }],
        },
        ...options,
    });
}

/** A problem+json answer as the engine would send it, for overriding one client method in a test. */
export function problemResponse(code: ProblemCode): Promise<EngineApiResponse<never>> {
    return Promise.resolve({ kind: 'problem', problem: createProblem(code) });
}
