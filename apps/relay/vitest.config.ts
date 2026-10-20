import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: [
                'src/**/*.test.ts',
                // Test support: shared suites and the fake DNS server, not product code.
                'src/testing/**',
                // The process entry: run as the built bundle by test/main.test.ts, outside v8 coverage.
                'src/main.ts',
            ],
            thresholds: {
                lines: 90,
                branches: 90,
                // Fail-closed code (cache expiry, hostname checks, config) stays covered on its own.
                'src/domain/**': { lines: 100, branches: 100 },
                'src/app/config.ts': { lines: 100, branches: 100 },
            },
        },
    },
});
