import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';

import { describeRelayPresenceStoreContract } from '../../testing/relay-presence-store-contract';
import { createDatabase } from './client';
import { createD1RelayPresenceStore } from './d1-relay-presence-store';

beforeEach(async () => {
    await env.DB.prepare('DELETE FROM relay_presence_reports').run();
});

describeRelayPresenceStoreContract('D1', () => createD1RelayPresenceStore(createDatabase(env.DB)));
