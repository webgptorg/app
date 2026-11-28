import { createAuthHarness } from '../../src/testing/auth-harness';
import { describeHeartbeatFlows, FLOW_HEARTBEAT } from '../../src/testing/heartbeat-flow-suite';
import { createMemoryAuthStore } from '../../src/testing/memory-auth-store';
import { createMemoryBillingStore } from '../../src/testing/memory-billing-store';
import { createMemoryRegistrationStores } from '../../src/testing/memory-registration-store';

describeHeartbeatFlows('heartbeats on the in-memory stores', () => {
    const store = createMemoryAuthStore();
    const registration = createMemoryRegistrationStores({ orgExists: (orgId) => store.state.orgs.has(orgId) });
    return {
        harness: createAuthHarness({
            store,
            billingStore: createMemoryBillingStore({ org: (orgId) => store.state.orgs.get(orgId) }),
            registration,
            heartbeat: FLOW_HEARTBEAT,
        }),
        suspend(engineId) {
            const engine = registration.state.engines.get(engineId);
            if (engine !== undefined) {
                registration.state.engines.set(engineId, { ...engine, status: 'suspended', statusReason: 'test' });
            }
            return Promise.resolve();
        },
    };
});
