import { createMemoryRelayPresenceStore } from './memory-relay-presence-store';
import { describeRelayPresenceStoreContract } from './relay-presence-store-contract';

describeRelayPresenceStoreContract('memory', createMemoryRelayPresenceStore);
