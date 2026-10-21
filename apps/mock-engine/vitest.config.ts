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
                // Process entries: wiring around start-mock-engine, the identity store, the dev CA and test releases.
                'src/main.ts',
                'src/identity.ts',
                'src/dev-ca.ts',
                'src/ui-test-release.ts',
            ],
            // Tunnel auth and identity are signature code (AGENTS.md step 6).
            thresholds: { lines: 90, branches: 90 },
        },
    },
});
