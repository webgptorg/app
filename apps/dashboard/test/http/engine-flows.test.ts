import { createAuthHarness } from '../../src/testing/auth-harness';
import { describeEngineFlows } from '../../src/testing/engine-flow-suite';
import { createMemoryAuthStore } from '../../src/testing/memory-auth-store';
import { createMemoryBillingStore } from '../../src/testing/memory-billing-store';
import { createMemoryRegistrationStores } from '../../src/testing/memory-registration-store';

const stores = new WeakMap<object, ReturnType<typeof createMemoryRegistrationStores>>();

describeEngineFlows(
    'engine registration on the in-memory stores',
    () => {
        const store = createMemoryAuthStore();
        const registration = createMemoryRegistrationStores({ orgExists: (orgId) => store.state.orgs.has(orgId) });
        const harness = createAuthHarness({
            store,
            billingStore: createMemoryBillingStore({ org: (orgId) => store.state.orgs.get(orgId) }),
            registration,
        });
        stores.set(harness, registration);
        return harness;
    },
    (harness) =>
        Promise.resolve(
            [...(stores.get(harness)?.state.linkCodes.values() ?? [])].flatMap((row): unknown[] => Object.values(row)),
        ),
);
