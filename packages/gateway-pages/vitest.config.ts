import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts', 'pages/gateway.js', 'pages/next-path.js'],
            exclude: ['src/**/*.test.ts', 'src/testing/**'],
            thresholds: { lines: 90, branches: 90 },
        },
    },
});
