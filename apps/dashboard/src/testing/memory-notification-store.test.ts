import { cryptoRandom } from '../adapters/crypto-random';
import { newOrgId, newUserId } from '../domain/ids';
import { createMemoryNotificationStore } from './memory-notification-store';
import { describeNotificationStoreContract } from './notification-store-contract';

describeNotificationStoreContract('memory', () => ({
    store: createMemoryNotificationStore(),
    addOrg: (userCount) =>
        Promise.resolve({
            orgId: newOrgId(cryptoRandom),
            userIds: Array.from({ length: userCount }, () => newUserId(cryptoRandom)),
        }),
}));
