import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { bundleBudget, formatReport, listRouteFiles, measureBundle } from './bundle-budget.ts';
import type { BundleBudgets, OutputAssetLike, OutputBundleLike, OutputChunkLike } from './bundle-budget.ts';

const routesDir = '/app/src/routes';
const budgets: BundleBudgets = { entry: 1000, routeDefault: 500, css: 300, routes: { 'big/index.tsx': 5000 } };

const code = (bytes: number, seed: number) => `/*${String(seed)}*/${'x'.repeat(bytes)}`;

function chunk(fileName: string, bytes: number, overrides: Partial<OutputChunkLike> = {}): OutputChunkLike {
    return {
        type: 'chunk',
        fileName,
        code: code(bytes, fileName.length),
        isEntry: false,
        isDynamicEntry: false,
        facadeModuleId: null,
        imports: [],
        ...overrides,
    };
}

const asset = (fileName: string, bytes: number): OutputAssetLike => ({
    type: 'asset',
    fileName,
    source: code(bytes, 3),
});

function bundleOf(...files: (OutputChunkLike | OutputAssetLike)[]): OutputBundleLike {
    return Object.fromEntries(files.map((file) => [file.fileName, file]));
}

const sample = bundleOf(
    chunk('assets/index.js', 600, { isEntry: true, imports: ['assets/vendor.js'] }),
    chunk('assets/vendor.js', 300),
    chunk('assets/agents.js', 200, {
        isDynamicEntry: true,
        facadeModuleId: `${routesDir}/agents/index.tsx?tsr-split=component`,
        imports: ['assets/vendor.js', 'assets/table.js'],
    }),
    chunk('assets/agents-error.js', 100, {
        isDynamicEntry: true,
        facadeModuleId: `${routesDir}/agents/index.tsx?tsr-split=errorComponent`,
    }),
    chunk('assets/table.js', 150),
    chunk('assets/big.js', 2000, { isDynamicEntry: true, facadeModuleId: `${routesDir}/big/index.tsx` }),
    chunk('assets/worker.js', 800, { isDynamicEntry: true, facadeModuleId: '/app/src/features/x/worker.ts' }),
    asset('assets/index.css', 400),
    asset('assets/logo.svg', 900),
);

function gzipBytes(...fileNames: string[]): number {
    return fileNames.reduce((total, fileName) => {
        const file = sample[fileName];
        if (file === undefined) throw new Error(`no ${fileName} in the sample`);
        return total + gzipSync(file.type === 'chunk' ? file.code : file.source).byteLength;
    }, 0);
}

describe('measureBundle', () => {
    const lines = measureBundle(sample, {
        budgets,
        routesDir,
        routeFiles: ['__root.tsx', 'agents/index.tsx', 'big/index.tsx'],
    });
    const line = (name: string) => lines.find((candidate) => candidate.name === name);

    it('measures the entry with its static imports', () => {
        expect(line('assets/index.js')).toEqual({
            kind: 'entry',
            name: 'assets/index.js',
            gzipBytes: gzipBytes('assets/index.js', 'assets/vendor.js'),
            budget: 1000,
        });
    });

    it("lists every route; a route counts all its split chunks and what the entry doesn't load", () => {
        expect(lines.filter((candidate) => candidate.kind === 'route').map((candidate) => candidate.name)).toEqual([
            '__root.tsx',
            'agents/index.tsx',
            'big/index.tsx',
        ]);
        expect(line('__root.tsx')).toEqual({ kind: 'route', name: '__root.tsx', gzipBytes: 0, budget: 500 });
        expect(line('agents/index.tsx')?.gzipBytes).toBe(
            gzipBytes('assets/agents.js', 'assets/agents-error.js', 'assets/table.js'),
        );
    });

    it('applies a per-route budget', () => {
        expect(line('big/index.tsx')).toMatchObject({ budget: 5000, gzipBytes: gzipBytes('assets/big.js') });
    });

    it('holds lazy chunks outside routes to the route budget', () => {
        expect(line('assets/worker.js')).toEqual({
            kind: 'lazy',
            name: 'assets/worker.js',
            gzipBytes: gzipBytes('assets/worker.js'),
            budget: 500,
        });
    });

    it('sums CSS only', () => {
        expect(line('*.css')).toEqual({
            kind: 'css',
            name: '*.css',
            gzipBytes: gzipBytes('assets/index.css'),
            budget: 300,
        });
    });
});

describe('formatReport', () => {
    it('marks each line ok or over', () => {
        expect(
            formatReport([
                { kind: 'entry', name: 'assets/index.js', gzipBytes: 10, budget: 20 },
                { kind: 'route', name: 'agents/index.tsx', gzipBytes: 30, budget: 20 },
            ]),
        ).toBe('ok   entry assets/index.js: 10 / 20 gzip bytes\nOVER route agents/index.tsx: 30 / 20 gzip bytes');
    });
});

describe('listRouteFiles', () => {
    it('lists route files and skips tests and `-` prefixed paths', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'routes-'));
        try {
            await mkdir(join(dir, 'agents', '-components'), { recursive: true });
            await Promise.all(
                ['__root.tsx', 'agents/index.tsx', 'agents/index.test.tsx', 'agents/-components/row.tsx', 'x.css'].map(
                    (file) => writeFile(join(dir, file), ''),
                ),
            );
            expect(await listRouteFiles(dir)).toEqual(['__root.tsx', 'agents/index.tsx']);
        } finally {
            await rm(dir, { recursive: true });
        }
    });
});

describe('bundleBudget plugin', () => {
    let appDir: string | undefined;
    afterEach(async () => {
        if (appDir !== undefined) await rm(appDir, { recursive: true });
        appDir = undefined;
    });

    async function run(enforce: boolean, budget: Partial<BundleBudgets>) {
        appDir = await mkdtemp(join(tmpdir(), 'engine-ui-'));
        await mkdir(join(appDir, 'src', 'routes', 'big'), { recursive: true });
        await writeFile(join(appDir, 'src', 'routes', 'big', 'index.tsx'), '');
        await writeFile(join(appDir, 'bundle-budget.json'), JSON.stringify({ ...budgets, ...budget }));
        const context = {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn((message: string): never => {
                throw new Error(message);
            }),
        };
        const bundle = bundleOf(
            chunk('assets/index.js', 100, { isEntry: true }),
            chunk('assets/big.js', 2000, {
                isDynamicEntry: true,
                facadeModuleId: join(appDir, 'src', 'routes', 'big', 'index.tsx'),
            }),
        );
        const plugin = bundleBudget({ appDir, enforce });
        const hook = plugin.generateBundle as unknown as (
            this: typeof context,
            o: unknown,
            b: unknown,
        ) => Promise<void>;
        const outcome = hook.call(context, {}, bundle);
        return {
            context,
            outcome,
            report: () => readFile(join(appDir ?? '', 'reports', 'bundle-budget.json'), 'utf8'),
        };
    }

    it('writes the report outside dist/ and passes within budget', async () => {
        const { context, outcome, report } = await run(true, {});
        await outcome;
        expect(context.error).not.toHaveBeenCalled();
        expect(context.info).toHaveBeenCalledWith(expect.stringContaining('big/index.tsx'));
        expect(JSON.parse(await report())).toContainEqual(expect.objectContaining({ name: 'big/index.tsx' }));
    });

    it('fails the build in CI when a route exceeds its budget', async () => {
        const { context, outcome } = await run(true, { routes: { 'big/index.tsx': 1 } });
        await expect(outcome).rejects.toThrow('over budget: big/index.tsx');
        expect(context.error).toHaveBeenCalledOnce();
    });

    it('only warns outside CI', async () => {
        const { context, outcome } = await run(false, { routes: { 'big/index.tsx': 1 } });
        await outcome;
        expect(context.warn).toHaveBeenCalledWith(expect.stringContaining('big/index.tsx'));
        expect(context.error).not.toHaveBeenCalled();
    });

    it('refuses a budget file with unknown fields', async () => {
        const { outcome } = await run(true, { extra: 1 } as Partial<BundleBudgets>);
        await expect(outcome).rejects.toThrow();
    });
});
