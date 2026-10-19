import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            // Test support is exercised by the tests themselves; counting it would only inflate the numbers.
            exclude: ['src/**/*.test.ts', 'src/testing/**'],
            reporter: ['text-summary', 'text'],
            thresholds: { lines: 90, branches: 90 },
        },
    },
});
