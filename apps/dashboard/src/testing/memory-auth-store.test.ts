import { describeAuthStoreContract } from './auth-store-contract';
import { createMemoryAuthStore } from './memory-auth-store';

describeAuthStoreContract('in memory', createMemoryAuthStore);
