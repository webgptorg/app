import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.test.ts'],
            // Signature verification (AGENTS.md step 6).
            thresholds: { lines: 90, branches: 90 },
        },
    },
});
