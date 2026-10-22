import { createAuthHarness } from '../../src/testing/auth-harness';
import { describeEngineListFlows } from '../../src/testing/engine-list-flow-suite';
import { createMemoryAuthStore } from '../../src/testing/memory-auth-store';
import { createMemoryBillingStore } from '../../src/testing/memory-billing-store';
import { createMemoryRegistrationStores } from '../../src/testing/memory-registration-store';

describeEngineListFlows('engine list on the in-memory stores', (options) => {
    const store = createMemoryAuthStore();
    const registration = createMemoryRegistrationStores({ orgExists: (orgId) => store.state.orgs.has(orgId) });
    return {
        harness: createAuthHarness({
            ...options,
            store,
            billingStore: createMemoryBillingStore({ org: (orgId) => store.state.orgs.get(orgId) }),
            registration,
        }),
        orgAudit: (orgId) =>
            Promise.resolve(
                registration.state.orgAudit
                    .filter((entry) => entry.orgId === orgId)
                    .map(({ orgId, actorUserId, action, targetType, targetId }) => ({
                        orgId,
                        actorUserId,
                        action,
                        targetType,
                        targetId,
                    })),
            ),
    };
});
