import { createAuthHarness } from '../../src/testing/auth-harness';
import { describeAuthFlows } from '../../src/testing/auth-flow-suite';
import { createMemoryAuthStore } from '../../src/testing/memory-auth-store';

describeAuthFlows(
    'auth flows on the in-memory store',
    () => createAuthHarness({ store: createMemoryAuthStore() }),
    (harness) => {
        const { state } = harness.store as ReturnType<typeof createMemoryAuthStore>;
        return Promise.resolve(
            JSON.stringify(
                Object.fromEntries(
                    Object.entries(state).map(([table, rows]) => [table, rows instanceof Map ? [...rows] : rows]),
                ),
            ),
        );
    },
);
