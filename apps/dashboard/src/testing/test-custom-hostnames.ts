import {
    ed25519SignatureFromBytes,
    Hostname,
    signHostnameClaim,
    type Ed25519Signature,
    type EngineId,
} from '@ptbk/protocol';

import { createFakeClock, type FakeClock } from '../adapters/fake-clock';
import { createFakeRandom } from '../adapters/fake-random';
import type { AdminAuditEntry } from '../domain/auth/records';
import { orgIdSchema, userIdSchema, type OrgId, type UserId } from '../domain/ids';
import type { Random } from '../domain/ports/random';
import { createFakeDnsResolver, type FakeDnsResolver } from './fake-dns-resolver';
import { createMemoryCustomHostnameStore, type MemoryCustomHostnameStore } from './memory-custom-hostname-store';
import { createMemoryRegistrationStores } from './memory-registration-store';
import { createTestEngine, engineRecord, TEST_ENGINE_DOMAIN, type TestEngine } from './test-engine';

export const CUSTOM_HOSTNAMES_START_MS = 1_800_000_000_000;
export const TEST_ORG = orgIdSchema.parse('orgorgorgorgorgorgorgorgor');
export const TEST_ADMIN = userIdSchema.parse('adminadminadminadminadmina');
export const TEST_RELAY = Hostname.parse('relay-1.ptbk.test');

export interface CustomHostnameFixture {
    readonly engine: TestEngine;
    readonly orgId: OrgId;
    readonly adminUserId: UserId;
    readonly store: MemoryCustomHostnameStore;
    readonly audit: AdminAuditEntry[];
    readonly dns: FakeDnsResolver;
    readonly clock: FakeClock;
    readonly random: Random;
    readonly engineDomain: Hostname;
    readonly reservedDomains: readonly Hostname[];
}

/** One registered engine, its hostnames in memory and an audit log to read back, for D-08's domain tests. */
export async function createCustomHostnameFixture(): Promise<CustomHostnameFixture> {
    const engine = await createTestEngine();
    const registration = createMemoryRegistrationStores({ orgExists: () => true });
    registration.state.engines.set(engine.engineId, engineRecord(engine, TEST_ORG));
    const audit: AdminAuditEntry[] = [];
    const store = createMemoryCustomHostnameStore({
        engines: registration.engines,
        auditLog: {
            append(entry) {
                audit.push(entry);
                return Promise.resolve();
            },
        },
    });
    return {
        engine,
        orgId: TEST_ORG,
        adminUserId: TEST_ADMIN,
        store,
        audit,
        dns: createFakeDnsResolver(),
        clock: createFakeClock(CUSTOM_HOSTNAMES_START_MS),
        random: createFakeRandom(),
        engineDomain: TEST_ENGINE_DOMAIN,
        reservedDomains: [Hostname.parse('ptbk.io'), TEST_ENGINE_DOMAIN, TEST_RELAY],
    };
}

/** The engine's claim as it would produce it with `PTBK_CUSTOM_DOMAIN`: its key, over the hostname and an engine ID. */
export async function signClaim(signer: TestEngine, hostname: string, engineId: EngineId): Promise<Ed25519Signature> {
    return ed25519SignatureFromBytes(await signHostnameClaim(signer.signer, Hostname.parse(hostname), engineId));
}
