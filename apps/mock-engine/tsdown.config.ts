import { defineConfig } from 'tsdown';

// One self-contained file, as for the relay: the protocol package ships raw .ts, and the host needs no node_modules.
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
        onlyBundle: [
            'zod',
            'ws',
            'hono',
            '@hono/node-server',
            '@faker-js/faker',
            // The UI loader (M-05): C-06's signature checks and the Sigstore verifier from @ptbk/release-tools.
            '@noble/curves',
            '@noble/hashes',
            '@sigstore/bundle',
            '@sigstore/core',
            '@sigstore/protobuf-specs',
            '@sigstore/verify',
        ],
        onlyImport: [],
    },
});
