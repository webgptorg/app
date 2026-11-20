import { EngineId } from '@ptbk/protocol';

import { cryptoRandom } from '../adapters/crypto-random';
import { newOrgId, newUserId } from '../domain/ids';
import type { ActiveEngine } from '../domain/usage/usage-store';
import { createMemoryUsageStore } from './memory-usage-store';
import { describeUsageStoreContract } from './usage-store-contract';
import { presenceEngineIds } from './relay-presence-store-contract';

describeUsageStoreContract('memory', () => {
    const engines: (ActiveEngine & { readonly status: 'active' | 'suspended' })[] = [];
    const sessions: { userId: string; activeOrgId: string; lastSeenAt: number }[] = [];
    const store = createMemoryUsageStore({
        engines: () =>
            engines.filter((engine) => engine.status === 'active').map(({ engineId, orgId }) => ({ engineId, orgId })),
        sessions: () => sessions,
    });
    return {
        store,
        addAccount(lastSeenAt = 0) {
            const account = { orgId: newOrgId(cryptoRandom), userId: newUserId(cryptoRandom) };
            sessions.push({ userId: account.userId, activeOrgId: account.orgId, lastSeenAt });
            return Promise.resolve(account);
        },
        addEngine(orgId, status = 'active') {
            const engineId = EngineId.parse(presenceEngineIds(1)[0]);
            engines.push({ engineId, orgId, status });
            return Promise.resolve(engineId);
        },
        events: () => Promise.resolve(store.state.events),
        engineDays: () => Promise.resolve([...store.state.engineDays.values()]),
        people: () => Promise.resolve([...store.state.people].sort()),
    };
});
