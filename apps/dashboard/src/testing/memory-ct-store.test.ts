import { describeCtStoreContract } from './ct-store-contract';
import { createMemoryCtStore } from './memory-ct-store';

describeCtStoreContract('memory', () => {
    const store = createMemoryCtStore();
    return {
        store,
        addEngine(hostname) {
            store.engineHostnames.add(hostname);
            return Promise.resolve();
        },
    };
});
