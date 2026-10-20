import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: [
                'src/**/*.test.ts',
                // Test support: fakes, the in-test relay, proxy and PKI, not product code.
                'src/testing/**',
                // Process entries: a few lines of wiring around start-mock-engine and the identity store.
                'src/main.ts',
                'src/identity.ts',
            ],
            // Tunnel auth and identity are signature code (AGENTS.md step 6).
            thresholds: { lines: 90, branches: 90 },
        },
    },
});
