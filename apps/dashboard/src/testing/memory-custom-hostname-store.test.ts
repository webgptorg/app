import type { AdminAuditEntry } from '../domain/auth/records';
import { testAccount } from './auth-store-contract';
import { describeCustomHostnameStoreContract } from './custom-hostname-store-contract';
import { createMemoryCustomHostnameStore } from './memory-custom-hostname-store';
import { createMemoryRegistrationStores } from './memory-registration-store';
import { createTestEngine, engineRecord } from './test-engine';

describeCustomHostnameStoreContract('memory', () => {
    const registration = createMemoryRegistrationStores({ orgExists: () => true });
    const audit: AdminAuditEntry[] = [];
    return {
        store: createMemoryCustomHostnameStore({
            engines: registration.engines,
            auditLog: {
                append(entry) {
                    audit.push(entry);
                    return Promise.resolve();
                },
            },
        }),
        async addEngine() {
            const engine = await createTestEngine();
            const { orgId } = testAccount();
            registration.state.engines.set(engine.engineId, engineRecord(engine, orgId));
            return { engine, orgId };
        },
        auditFor: (engineId) => Promise.resolve(audit.filter((entry) => entry.targetId.startsWith(`${engineId}/`))),
    };
});
