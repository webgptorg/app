import type { EngineApiTransport } from '../client';
import { actorFromOptions, createInMemoryEngineCore } from '../in-memory-client';
import type { InMemoryEngineApiOptions, InMemoryEngineController } from '../in-memory-client';

/**
 * The engine side of the in-memory client, acting as the member the options describe: it resolves with exactly what
 * an engine would send, so tests can serve it over HTTP to drive the fetch client.
 */
export function createInMemoryEngineApiTransport(options: InMemoryEngineApiOptions = {}): {
    readonly transport: EngineApiTransport;
    readonly controller: InMemoryEngineController;
} {
    const core = createInMemoryEngineCore(options);
    return { transport: core.transport(actorFromOptions(options)), controller: core.controller };
}
