import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createMockEngineTarget } from '../../src/index';
import { freeLoopbackPort } from '../harness/loopback';
import type { EngineTargetFactory } from '../harness/platform';

const CONTROL_PORT = 'MOCK_CONTROL_PORT';

/**
 * Engine API sessions for mock engines the harness starts: each gets its own dev-only control listener on a loopback
 * port chosen before it is spawned, so the port stays the same across restarts, and `session()` signs in through it
 * (`POST /__mock/sessions`). Mock-only: a real engine brings its own factory (the open "conformance sessions" point).
 */
export function createMockEngineTargetFactory(): EngineTargetFactory {
    return {
        async engineEnv() {
            return {
                MOCK_CONTROL: 'enabled',
                MOCK_CONTROL_HOST: '127.0.0.1',
                [CONTROL_PORT]: String(await freeLoopbackPort()),
            };
        },
        target(engine, endpoint) {
            const port = engine.env[CONTROL_PORT];
            if (port === undefined) throw new Error('this engine was not started with a mock control listener');
            // The control listener is plain loopback HTTP; only the engine API goes through the relay.
            const target = createMockEngineTarget({
                baseUrl: endpoint.baseUrl,
                controlUrl: new URL(`http://127.0.0.1:${port}`),
                fetch: globalThis.fetch.bind(globalThis),
            });
            return { ...target, fetch: endpoint.fetch };
        },
        async certificateAuthority(engine) {
            // The mock issues its certificates from a dev CA it generates in its data directory on first start.
            return readFile(join(engine.dataDir, 'dev-ca', 'ca-cert.pem'), 'utf8').catch(() => null);
        },
    };
}
