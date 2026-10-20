import type { EngineId, RegistryEntry } from '@ptbk/protocol';

import type { EngineRegistry, RegistryLookup } from '../domain/engine-registry';

/** `answer` serves the stored entries; the others simulate a failing registry. `hang` waits for the abort. */
export type InMemoryRegistryMode = 'answer' | 'unavailable' | 'throw' | 'hang';

export interface InMemoryRegistry extends EngineRegistry {
    set(engineId: EngineId, entry: RegistryEntry): void;
    delete(engineId: EngineId): void;
    setMode(mode: InMemoryRegistryMode): void;
    /** Every call to `lookup`, including failed ones. */
    readonly calls: () => number;
}

export function createInMemoryRegistry(entries: Iterable<readonly [EngineId, RegistryEntry]> = []): InMemoryRegistry {
    const stored = new Map<EngineId, RegistryEntry>(entries);
    let mode: InMemoryRegistryMode = 'answer';
    let calls = 0;
    return {
        lookup(engineId, signal): Promise<RegistryLookup> {
            calls++;
            if (signal.aborted) return Promise.reject(signal.reason as Error);
            switch (mode) {
                case 'answer': {
                    const entry = stored.get(engineId);
                    return Promise.resolve(entry === undefined ? { kind: 'not-found' } : { kind: 'found', entry });
                }
                case 'unavailable':
                    return Promise.resolve({ kind: 'unavailable' });
                case 'throw':
                    return Promise.reject(new Error('registry failure'));
                case 'hang':
                    return new Promise((_, reject) => {
                        signal.addEventListener(
                            'abort',
                            () => {
                                reject(signal.reason as Error);
                            },
                            { once: true },
                        );
                    });
            }
        },
        set(engineId, entry) {
            stored.set(engineId, entry);
        },
        delete(engineId) {
            stored.delete(engineId);
        },
        setMode(next) {
            mode = next;
        },
        calls: () => calls,
    };
}
