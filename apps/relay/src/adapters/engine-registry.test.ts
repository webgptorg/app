import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeEngineRegistry } from '../testing/engine-registry-suite';
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
