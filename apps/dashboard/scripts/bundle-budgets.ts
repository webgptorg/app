import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { z } from 'zod';

const manifestSchema = z.record(
    z.string(),
    z.object({
        file: z.string(),
        isEntry: z.boolean().optional(),
        isDynamicEntry: z.boolean().optional(),
        imports: z.array(z.string()).optional(),
    }),
);
type Manifest = z.infer<typeof manifestSchema>;

export const budgetsSchema = z.strictObject({
    $comment: z.string().optional(),
    entry: z.number().int().positive(),
    routeDefault: z.number().int().positive(),
    routes: z.record(z.string(), z.number().int().positive()),
});
export type Budgets = z.infer<typeof budgetsSchema>;

export interface ChunkMeasurement {
    readonly key: string;
    readonly kind: 'entry' | 'route';
    readonly gzipBytes: number;
    readonly budget: number;
}

/** A chunk plus everything it imports statically, minus what `exclude` (the entry's graph) already loaded. */
function staticGraph(manifest: Manifest, key: string, exclude: ReadonlySet<string>): Set<string> {
    const seen = new Set<string>();
    const visit = (current: string): void => {
        if (seen.has(current) || exclude.has(current)) {
            return;
        }
        seen.add(current);
        for (const next of manifest[current]?.imports ?? []) {
            visit(next);
        }
    };
    visit(key);
    return seen;
}

/** Route keys drop TanStack Router's split query (`?tsr-split=component`), so budgets name the route file. */
function routeName(key: string): string {
    return key.replace(/\?.*$/, '');
}

export async function measureBundles(clientDir: string, budgets: Budgets): Promise<readonly ChunkMeasurement[]> {
    const manifest = manifestSchema.parse(
        JSON.parse(await readFile(join(clientDir, '.vite', 'manifest.json'), 'utf8')),
    );
    const sizeOf = async (keys: Iterable<string>): Promise<number> => {
        let total = 0;
        for (const key of keys) {
            const file = manifest[key]?.file;
            if (file !== undefined && file.endsWith('.js')) {
                total += gzipSync(await readFile(join(clientDir, file))).byteLength;
            }
        }
        return total;
    };
    const entries = Object.keys(manifest).filter((key) => manifest[key]?.isEntry === true);
    const entryGraph = new Set(entries.flatMap((key) => [...staticGraph(manifest, key, new Set())]));
    const measurements: ChunkMeasurement[] = [];
    for (const key of entries) {
        measurements.push({
            key,
            kind: 'entry',
            gzipBytes: await sizeOf(staticGraph(manifest, key, new Set())),
            budget: budgets.entry,
        });
    }
    for (const key of Object.keys(manifest).filter((candidate) => manifest[candidate]?.isDynamicEntry === true)) {
        const name = routeName(key);
        measurements.push({
            key: name,
            kind: 'route',
            gzipBytes: await sizeOf(staticGraph(manifest, key, entryGraph)),
            budget: budgets.routes[name] ?? budgets.routeDefault,
        });
    }
    return measurements;
}
