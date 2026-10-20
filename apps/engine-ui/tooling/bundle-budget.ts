import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

import type { Plugin } from 'vite';
import { z } from 'zod';

export const BundleBudgets = z.strictObject({
    $comment: z.string().optional(),
    entry: z.int().positive(),
    routeDefault: z.int().positive(),
    css: z.int().positive(),
    routes: z.record(z.string(), z.int().positive()),
});
export type BundleBudgets = z.infer<typeof BundleBudgets>;

/** The parts of a Rollup/Rolldown output bundle the budget reads; structural, so tests can build one by hand. */
export interface OutputChunkLike {
    readonly type: 'chunk';
    readonly fileName: string;
    readonly code: string;
    readonly isEntry: boolean;
    readonly isDynamicEntry: boolean;
    readonly facadeModuleId: string | null;
    readonly imports: readonly string[];
}
export interface OutputAssetLike {
    readonly type: 'asset';
    readonly fileName: string;
    readonly source: string | Uint8Array;
}
export type OutputBundleLike = Readonly<Record<string, OutputChunkLike | OutputAssetLike>>;

export interface BudgetLine {
    readonly kind: 'entry' | 'route' | 'lazy' | 'css';
    /** The entry chunk's file, a route file relative to the routes directory, or `*.css`. */
    readonly name: string;
    readonly gzipBytes: number;
    readonly budget: number;
}

export interface MeasureOptions {
    readonly budgets: BundleBudgets;
    readonly routesDir: string;
    /** Every route file relative to `routesDir`, so a route without a chunk of its own is still reported. */
    readonly routeFiles: readonly string[];
}

export function measureBundle(bundle: OutputBundleLike, options: MeasureOptions): BudgetLine[] {
    const chunks = Object.values(bundle).filter((file): file is OutputChunkLike => file.type === 'chunk');
    const byFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
    const gzipBytes = (fileNames: Iterable<string>): number => {
        let total = 0;
        for (const fileName of fileNames) {
            const chunk = byFileName.get(fileName);
            if (chunk !== undefined) total += gzipSync(chunk.code).byteLength;
        }
        return total;
    };
    const staticGraph = (roots: readonly OutputChunkLike[], exclude: ReadonlySet<string>): Set<string> => {
        const seen = new Set<string>();
        const visit = (fileName: string): void => {
            if (seen.has(fileName) || exclude.has(fileName)) return;
            seen.add(fileName);
            for (const next of byFileName.get(fileName)?.imports ?? []) visit(next);
        };
        for (const root of roots) visit(root.fileName);
        return seen;
    };

    const entries = chunks.filter((chunk) => chunk.isEntry);
    const entryGraph = staticGraph(entries, new Set());
    const lines: BudgetLine[] = entries.map((chunk) => ({
        kind: 'entry',
        name: chunk.fileName,
        gzipBytes: gzipBytes(staticGraph([chunk], new Set())),
        budget: options.budgets.entry,
    }));

    // TanStack Router's code splitting turns one route file into several virtual modules (`?tsr-split=component`).
    const routeOf = (chunk: OutputChunkLike): string | undefined => {
        const moduleId = chunk.facadeModuleId?.replace(/\?.*$/, '');
        if (moduleId === undefined) return undefined;
        const routeFile = relative(options.routesDir, moduleId);
        return options.routeFiles.includes(routeFile) ? routeFile : undefined;
    };
    const lazyChunks = chunks.filter((chunk) => chunk.isDynamicEntry && !chunk.isEntry);
    for (const routeFile of options.routeFiles) {
        const routeChunks = lazyChunks.filter((chunk) => routeOf(chunk) === routeFile);
        lines.push({
            kind: 'route',
            name: routeFile,
            gzipBytes: gzipBytes(staticGraph(routeChunks, entryGraph)),
            budget: options.budgets.routes[routeFile] ?? options.budgets.routeDefault,
        });
    }
    // Any other lazy chunk gets the route budget too, so code cannot escape the budget by moving out of a route.
    for (const chunk of lazyChunks.filter((candidate) => routeOf(candidate) === undefined)) {
        lines.push({
            kind: 'lazy',
            name: chunk.fileName,
            gzipBytes: gzipBytes(staticGraph([chunk], entryGraph)),
            budget: options.budgets.routeDefault,
        });
    }

    let cssBytes = 0;
    for (const file of Object.values(bundle)) {
        if (file.type === 'asset' && file.fileName.endsWith('.css')) cssBytes += gzipSync(file.source).byteLength;
    }
    lines.push({ kind: 'css', name: '*.css', gzipBytes: cssBytes, budget: options.budgets.css });
    return lines;
}

export function formatReport(lines: readonly BudgetLine[]): string {
    return lines
        .map(({ kind, name, gzipBytes, budget }) => {
            const mark = gzipBytes <= budget ? 'ok  ' : 'OVER';
            return `${mark} ${kind.padEnd(5)} ${name}: ${String(gzipBytes)} / ${String(budget)} gzip bytes`;
        })
        .join('\n');
}

export async function listRouteFiles(routesDir: string): Promise<string[]> {
    const files = await readdir(routesDir, { recursive: true });
    // TanStack Router skips files and folders prefixed with `-`; tests are not routes.
    return files
        .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
        .filter((file) => !file.split(/[\\/]/).some((segment) => segment.startsWith('-')))
        .sort();
}

export interface BundleBudgetOptions {
    readonly appDir: string;
    /** Fail the build when over budget (CI); otherwise warn. */
    readonly enforce: boolean;
}

/**
 * Checks gzip sizes against `bundle-budget.json` while the bundle is generated. The report goes to
 * `reports/bundle-budget.json`, outside `dist/`, so `dist/` stays exactly what is signed and shipped.
 */
export function bundleBudget(options: BundleBudgetOptions): Plugin {
    const routesDir = join(options.appDir, 'src', 'routes');
    const reportFile = join(options.appDir, 'reports', 'bundle-budget.json');
    return {
        name: 'ptbk-bundle-budget',
        apply: 'build',
        async generateBundle(_outputOptions, bundle) {
            const budgets = BundleBudgets.parse(
                JSON.parse(await readFile(join(options.appDir, 'bundle-budget.json'), 'utf8')),
            );
            const lines = measureBundle(bundle, { budgets, routesDir, routeFiles: await listRouteFiles(routesDir) });
            await mkdir(dirname(reportFile), { recursive: true });
            await writeFile(reportFile, `${JSON.stringify(lines, null, 2)}\n`);
            this.info(`bundle budget\n${formatReport(lines)}`);
            const over = lines.filter((line) => line.gzipBytes > line.budget);
            if (over.length === 0) return;
            const message = `over budget: ${over.map((line) => line.name).join(', ')} (see bundle-budget.json)`;
            if (options.enforce) this.error(message);
            this.warn(message);
        },
    };
}
