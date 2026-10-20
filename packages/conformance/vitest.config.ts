import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/**/*.test.ts', 'bin/**/*.test.ts'],
        // The self-test runs the whole suite against in-process engines; the default 5 s is too tight for that.
        testTimeout: 60_000,
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts', 'bin/**/*.ts'],
            // Test support is exercised by the tests themselves; counting it would only inflate the numbers.
            exclude: ['**/*.test.ts', 'src/testing/**', 'bin/ptbk-conformance.ts'],
            reporter: ['text-summary', 'text'],
            // It decides whether an engine checks permissions and keeps secrets (AGENTS.md step 6).
            thresholds: { lines: 90, branches: 90 },
        },
    },
});
