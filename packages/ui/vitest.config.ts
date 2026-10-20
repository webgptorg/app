import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        coverage: {
            provider: 'v8',
            include: ['src/**/*.{ts,tsx}'],
            exclude: ['**/*.test.{ts,tsx}', 'src/testing/**', 'src/**/*.gallery.tsx', 'src/gallery.tsx'],
            reporter: ['text-summary', 'text'],
            thresholds: { lines: 90, branches: 90 },
        },
        projects: [
            {
                test: {
                    name: 'dom',
                    environment: 'jsdom',
                    include: ['src/**/*.test.{ts,tsx}'],
                    setupFiles: ['./src/testing/setup.ts'],
                },
            },
            {
                // Reads the package's files (CSS layers, fonts, sources) and runs ESLint; no DOM.
                test: { name: 'node', environment: 'node', include: ['test/**/*.test.ts'] },
            },
        ],
    },
});
