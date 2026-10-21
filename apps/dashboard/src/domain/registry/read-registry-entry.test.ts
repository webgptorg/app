import {
    defaultHostname,
    ed25519SignatureFromBytes,
    Hostname,
    signHostnameClaim,
    type HostnameClaim,
} from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createMemoryEngineHostnameStore } from '../../testing/memory-registry-stores';
import { createRegistryTestDeps } from '../../testing/test-registry';
import { createTestEngine, TEST_ENGINE_DOMAIN, type TestEngine } from '../../testing/test-engine';
import type { RegistryReader } from './registry-reader';
import { readRegistryEntry } from './read-registry-entry';

async function claim(signer: TestEngine, owner: TestEngine, hostname: string): Promise<HostnameClaim> {
    const parsed = Hostname.parse(hostname);
    return {
        hostname: parsed,
        sig: ed25519SignatureFromBytes(await signHostnameClaim(signer.signer, parsed, owner.engineId)),
    };
}

async function setup() {
    const engine = await createTestEngine();
    const registry: RegistryReader = {
        findEngine: (engineId) =>
            Promise.resolve(engineId === engine.engineId ? { publicKey: engine.publicKey, status: 'active' } : null),
    };
    const engineHostnames = createMemoryEngineHostnameStore();
    const { logger } = createRegistryTestDeps();
    const deps = { registry, engineHostnames, logger, engineDomain: TEST_ENGINE_DOMAIN };
    return { engine, engineHostnames, logger, deps };
}

describe('readRegistryEntry', () => {
    it('answers not-found for an engine the registry does not hold', async () => {
        const { deps } = await setup();
        expect(await readRegistryEntry(deps, (await createTestEngine()).engineId)).toEqual({ kind: 'not-found' });
    });

    it('serves the default hostname without a claim', async () => {
        const { engine, deps, logger } = await setup();
        expect(await readRegistryEntry(deps, engine.engineId)).toEqual({
            kind: 'found',
            entry: {
                enginePublicKey: engine.publicKey,
                hostnames: [defaultHostname(engine.engineId, TEST_ENGINE_DOMAIN)],
                claims: [],
                status: 'active',
            },
        });
        expect(logger.entries).toEqual([]);
    });

    it('keeps verifying claims and drops forged, duplicated and engine-domain ones, logging the count only', async () => {
        const { engine, engineHostnames, deps, logger } = await setup();
        const other = await createTestEngine();
        const good = await claim(engine, engine, 'agents.customer.test');
        const twice = await claim(engine, engine, 'twice.customer.test');
        const claims = [
            good,
            await claim(other, engine, 'forged.customer.test'),
            twice,
            twice,
            await claim(engine, engine, `x.${TEST_ENGINE_DOMAIN}`),
        ];
        engineHostnames.set(engine.engineId, claims);
        const outcome = await readRegistryEntry(deps, engine.engineId);
        expect(outcome).toMatchObject({
            kind: 'found',
            entry: { hostnames: [defaultHostname(engine.engineId, TEST_ENGINE_DOMAIN), good.hostname], claims: [good] },
        });
        expect(logger.entries).toEqual([
            { level: 'warn', event: 'registry.claims-dropped', fields: { engineId: engine.engineId, count: 3 } },
        ]);
    });
});
