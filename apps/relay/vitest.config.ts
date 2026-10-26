import { configDefaults, defineConfig } from 'vitest/config';

const FAIRNESS = 'test/fairness.test.ts';

export default defineConfig({
    test: {
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
        projects: [
            {
                extends: true,
                test: {
                    name: 'relay',
                    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
                    exclude: [...configDefaults.exclude, FAIRNESS],
                    sequence: { groupOrder: 0 },
                },
            },
            {
                // Compares latencies, so it runs alone, after the other files and without coverage (`test` script).
                // Other load on the machine can still skew one run; a real regression fails every attempt.
                extends: true,
                test: { name: 'fairness', include: [FAIRNESS], retry: 2, sequence: { groupOrder: 1 } },
            },
        ],
    },
});
