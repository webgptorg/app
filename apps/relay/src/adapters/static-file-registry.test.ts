import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestEngine } from '../testing/engines';
import type { TestEngine } from '../testing/engines';
import { createMemoryLogger } from './memory-logger';
import { StaticRegistryError, createStaticFileRegistry } from './static-file-registry';

const signal = new AbortController().signal;

function fileOf(...engines: readonly TestEngine[]): Record<string, unknown> {
    return { v: 1, engines: engines.map(({ engineId, entry }) => ({ engineId, ...entry })) };
}

describe('static file registry', () => {
    let dir: string;
    let path: string;
    let alpha: TestEngine;
    let beta: TestEngine;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'relay-static-'));
        path = join(dir, 'registry.json');
        alpha = await createTestEngine(10, ['agents.customer.test']);
        beta = await createTestEngine(11);
    });
    afterEach(async () => {
        await rm(dir, { recursive: true });
    });

    const write = (content: unknown): Promise<void> =>
        writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));

    it.each([
        ['an unknown top-level field', (file: Record<string, unknown>) => ({ ...file, comment: 'x' }), '(root)'],
        [
            'an unknown field in an engine',
            (file: Record<string, unknown>) => ({
                ...file,
                engines: [{ ...(file['engines'] as object[])[0], owner: 'someone@customer.test' }],
            }),
            'engines.0',
        ],
        ['another version', (file: Record<string, unknown>) => ({ ...file, v: 2 }), 'v'],
    ])('refuses to start on a file with %s, naming only the path', async (_, mutate, where) => {
        await write(mutate(fileOf(alpha)));
        const failure = createStaticFileRegistry({ path, logger: createMemoryLogger() });
        await expect(failure).rejects.toBeInstanceOf(StaticRegistryError);
        await expect(failure).rejects.toThrow(`schema at ${where}`);
        await expect(failure).rejects.not.toThrow(/someone@customer/);
    });

    it('refuses duplicate engine IDs', async () => {
        await write(fileOf(alpha, alpha));
        await expect(createStaticFileRegistry({ path, logger: createMemoryLogger() })).rejects.toThrow(
            'schema at engines.1.engineId',
        );
    });

    it('refuses a missing file and a file that is not JSON', async () => {
        await expect(createStaticFileRegistry({ path, logger: createMemoryLogger() })).rejects.toThrow('(unreadable)');
        await write('{ v: 1');
        await expect(createStaticFileRegistry({ path, logger: createMemoryLogger() })).rejects.toThrow('(not-json)');
    });

    it('swaps in a valid file on reload', async () => {
        await write(fileOf(alpha));
        const logger = createMemoryLogger();
        const registry = await createStaticFileRegistry({ path, logger });
        await write(fileOf(beta));
        await expect(registry.reload()).resolves.toEqual({ kind: 'loaded', engines: 1 });
        await expect(registry.lookup(alpha.engineId, signal)).resolves.toEqual({ kind: 'not-found' });
        await expect(registry.lookup(beta.engineId, signal)).resolves.toEqual({ kind: 'found', entry: beta.entry });
        expect(logger.entries.map((entry) => entry.event)).toEqual(['registry.loaded', 'registry.loaded']);
    });

    it.each([
        ['an invalid file', () => write({ ...fileOf(beta), extra: true }), 'schema'],
        ['a file that is not JSON', () => write('not json'), 'not-json'],
        ['a deleted file', () => rm(path), 'unreadable'],
    ])('keeps the previous entries when reloading %s', async (_, breakFile, reason) => {
        await write(fileOf(alpha));
        const logger = createMemoryLogger();
        const registry = await createStaticFileRegistry({ path, logger });
        await breakFile();
        await expect(registry.reload()).resolves.toMatchObject({ kind: 'invalid', reason });
        await expect(registry.lookup(alpha.engineId, signal)).resolves.toEqual({ kind: 'found', entry: alpha.entry });
        expect(logger.entries.at(-1)).toEqual({ level: 'error', event: 'registry.reload-failed', fields: { reason } });
    });
});
