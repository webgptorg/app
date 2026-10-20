import { defineConfig } from 'tsdown';

// One self-contained file: the protocol package ships raw .ts, and the host needs no node_modules (only node:*).
export default defineConfig({
    entry: { main: 'src/main.ts' },
    format: 'esm',
    platform: 'node',
    target: 'node24',
    outDir: 'dist',
    fixedExtension: true,
    sourcemap: true,
    minify: false,
    dts: false,
    clean: true,
    deps: {
        alwaysBundle: [/.*/],
        onlyBundle: ['zod', 'ws', /^@noble\//],
        onlyImport: [],
    },
});
