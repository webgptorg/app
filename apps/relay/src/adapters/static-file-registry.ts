import { readFile } from 'node:fs/promises';

import type { RegistryEntry } from '@ptbk/protocol';
import { EngineId, RegistryEntry as RegistryEntrySchema } from '@ptbk/protocol';
import { z } from 'zod';

import type { EngineRegistry } from '../domain/engine-registry';
import type { Logger } from '../domain/logger';

/** Written by hand or by X-01's generator; strict, because it is our own configuration, not a peer's response. */
export const StaticRegistryFile = z
    .strictObject({
        v: z.literal(1),
        engines: z.array(RegistryEntrySchema.extend({ engineId: EngineId })),
    })
    .superRefine((file, ctx) => {
        const seen = new Set<string>();
        file.engines.forEach((engine, index) => {
            if (seen.has(engine.engineId)) {
                ctx.addIssue({ code: 'custom', path: ['engines', index, 'engineId'], message: 'duplicate engine ID' });
            }
            seen.add(engine.engineId);
        });
    });
export type StaticRegistryFile = z.infer<typeof StaticRegistryFile>;

export type StaticRegistryLoad =
    | { readonly kind: 'loaded'; readonly engines: number }
    | {
          readonly kind: 'invalid';
          readonly reason: 'unreadable' | 'not-json' | 'schema';
          readonly paths: readonly string[];
      };

export interface StaticFileRegistry extends EngineRegistry {
    /** Re-reads the file; when it is unreadable or invalid, the previous contents stay in place. */
    reload(): Promise<StaticRegistryLoad>;
}

export class StaticRegistryError extends Error {
    constructor(load: Extract<StaticRegistryLoad, { kind: 'invalid' }>) {
        const where = load.paths.length > 0 ? ` at ${load.paths.join(', ')}` : '';
        super(`Invalid static registry file (${load.reason}${where})`);
        this.name = 'StaticRegistryError';
    }
}

type Entries = ReadonlyMap<EngineId, RegistryEntry>;

async function read(
    path: string,
): Promise<{ kind: 'ok'; entries: Entries } | Extract<StaticRegistryLoad, { kind: 'invalid' }>> {
    let text: string;
    try {
        text = await readFile(path, 'utf8');
    } catch {
        return { kind: 'invalid', reason: 'unreadable', paths: [] };
    }
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        return { kind: 'invalid', reason: 'not-json', paths: [] };
    }
    const parsed = StaticRegistryFile.safeParse(json);
    if (!parsed.success) {
        // Paths only (`engines.0.claims`): values and unknown key names are file contents.
        const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'))];
        return { kind: 'invalid', reason: 'schema', paths };
    }
    return {
        kind: 'ok',
        entries: new Map(parsed.data.engines.map(({ engineId, ...entry }) => [engineId, entry] as const)),
    };
}

/**
 * The registry for local development and e2e. Throws {@link StaticRegistryError} when the file is invalid at start, so
 * the relay never runs on a half-read registry.
 */
export async function createStaticFileRegistry(options: {
    readonly path: string;
    readonly logger: Logger;
}): Promise<StaticFileRegistry> {
    const { path, logger } = options;
    const initial = await read(path);
    if (initial.kind === 'invalid') throw new StaticRegistryError(initial);
    let entries = initial.entries;
    logger.info('registry.loaded', { engines: entries.size });
    return {
        lookup(engineId, signal) {
            if (signal.aborted) return Promise.reject(signal.reason as Error);
            const entry = entries.get(engineId);
            return Promise.resolve(entry === undefined ? { kind: 'not-found' } : { kind: 'found', entry });
        },
        async reload() {
            const next = await read(path);
            if (next.kind === 'invalid') {
                logger.error('registry.reload-failed', { reason: next.reason });
                return next;
            }
            entries = next.entries;
            logger.info('registry.loaded', { engines: entries.size });
            return { kind: 'loaded', engines: entries.size };
        },
    };
}
