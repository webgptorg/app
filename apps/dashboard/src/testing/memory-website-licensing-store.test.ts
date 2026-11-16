import { cryptoRandom } from '../adapters/crypto-random';
import { newOrgId, newUserId, type UserId } from '../domain/ids';
import { createMemoryWebsiteLicensingStore } from './memory-website-licensing-store';
import { describeWebsiteLicensingStoreContract } from './website-licensing-store-contract';

describeWebsiteLicensingStoreContract('memory', () => {
    const emails = new Map<UserId, string>();
    const store = createMemoryWebsiteLicensingStore((userId) => emails.get(userId) ?? null);
    return {
        store,
        addOrg() {
            const userId = newUserId(cryptoRandom);
            const email = `${userId}@example.test`;
            emails.set(userId, email);
            return Promise.resolve({ orgId: newOrgId(cryptoRandom), userId, email });
        },
        linkAudit: (orgId) =>
            Promise.resolve(store.audit.filter((entry) => entry.orgId === orgId).map((entry) => entry.targetId)),
    };
});
