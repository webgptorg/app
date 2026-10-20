import type { EngineId, RegistryEntry } from '@ptbk/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { EngineRegistry } from '../domain/engine-registry';
import { createTestEngine } from './engines';

export interface RegistryUnderTest {
    readonly registry: EngineRegistry;
    close?(): Promise<void>;
}

/** Builds an adapter serving exactly `engines`. */
export type RegistryFactory = (
    engines: readonly { readonly engineId: EngineId; readonly entry: RegistryEntry }[],
) => Promise<RegistryUnderTest>;

/** The `EngineRegistry` contract every adapter passes (in-memory, static file, and D-04's HTTP adapter). */
export function describeEngineRegistry(name: string, factory: RegistryFactory): void {
    describe(`EngineRegistry: ${name}`, () => {
        let current: RegistryUnderTest | undefined;
        afterEach(async () => {
            await current?.close?.();
            current = undefined;
        });

        async function serving(...engines: Parameters<RegistryFactory>[0]): Promise<EngineRegistry> {
            current = await factory(engines);
            return current.registry;
        }

        it('finds a registered engine with its entry as served', async () => {
            const engine = await createTestEngine(1, ['agents.customer.test']);
            const other = await createTestEngine(2);
            const registry = await serving(engine, other);
            await expect(registry.lookup(engine.engineId, new AbortController().signal)).resolves.toEqual({
                kind: 'found',
                entry: engine.entry,
            });
        });

        it('returns suspended engines as found, leaving the decision to the caller', async () => {
            const engine = await createTestEngine(3);
            const registry = await serving({ ...engine, entry: { ...engine.entry, status: 'suspended' } });
            const lookup = await registry.lookup(engine.engineId, new AbortController().signal);
            expect(lookup.kind === 'found' && lookup.entry.status).toBe('suspended');
        });

        it('answers not-found for an unknown engine', async () => {
            const engine = await createTestEngine(4);
            const unknown = await createTestEngine(5);
            const registry = await serving(engine);
            await expect(registry.lookup(unknown.engineId, new AbortController().signal)).resolves.toEqual({
                kind: 'not-found',
            });
        });

        it('rejects with the abort reason when the signal is already aborted', async () => {
            const engine = await createTestEngine(6);
            const registry = await serving(engine);
            const reason = new Error('caller gave up');
            await expect(registry.lookup(engine.engineId, AbortSignal.abort(reason))).rejects.toBe(reason);
        });
    });
}
