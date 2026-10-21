import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeEngineRegistry } from '../testing/engine-registry-suite';
import { TEST_RELAY_TOKEN, startFakeDashboard } from '../testing/fake-dashboard';
import { systemClock } from './system-clock';
import { createHttpEngineRegistry } from './http-engine-registry';
import { createInMemoryRegistry } from './in-memory-registry';
import { createMemoryLogger } from './memory-logger';
import { createStaticFileRegistry } from './static-file-registry';

describeEngineRegistry('in-memory', (engines) =>
    Promise.resolve({ registry: createInMemoryRegistry(engines.map(({ engineId, entry }) => [engineId, entry])) }),
);

describeEngineRegistry('static file', async (engines) => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-registry-'));
    const path = join(dir, 'registry.json');
    await writeFile(
        path,
        JSON.stringify({ v: 1, engines: engines.map(({ engineId, entry }) => ({ engineId, ...entry })) }),
    );
    return {
        registry: await createStaticFileRegistry({ path, logger: createMemoryLogger() }),
        close: () => rm(dir, { recursive: true }),
    };
});

describeEngineRegistry('HTTP (D-04, against a fake dashboard)', async (engines) => {
    const dashboard = await startFakeDashboard(
        createInMemoryRegistry(engines.map(({ engineId, entry }) => [engineId, entry])),
    );
    return {
        registry: createHttpEngineRegistry({
            fetch: (input, init) => fetch(input, init),
            clock: systemClock,
            logger: createMemoryLogger(),
            config: { url: dashboard.url, token: { reveal: () => TEST_RELAY_TOKEN }, timeoutMs: 3000 },
        }),
        close: () => dashboard.close(),
    };
});
