import { env } from 'cloudflare:workers';

import { createAuthHarness } from '../../src/testing/auth-harness';
import { describeAuthFlows } from '../../src/testing/auth-flow-suite';
import { createDatabase } from '../../src/adapters/db/client';
import { createD1AuthStore } from '../../src/adapters/db/d1-auth-store';

const TABLES = ['users', 'organizations', 'memberships', 'passkeys', 'sessions', 'email_tokens', 'webauthn_challenges'];

describeAuthFlows(
    'auth flows on D1',
    () => createAuthHarness({ store: createD1AuthStore(createDatabase(env.DB)) }),
    async () => {
        const rows = await Promise.all(TABLES.map((table) => env.DB.prepare(`SELECT * FROM ${table}`).all()));
        return JSON.stringify(rows.map((result) => result.results));
    },
);
