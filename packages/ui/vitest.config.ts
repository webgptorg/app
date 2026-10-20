import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        include: ['src/**/*.test.{ts,tsx}'],
        setupFiles: ['./src/testing/setup.ts'],
        coverage: {
            provider: 'v8',
            include: ['src/**/*.{ts,tsx}'],
            exclude: ['**/*.test.{ts,tsx}', 'src/testing/**', 'src/**/*.gallery.tsx', 'src/gallery.tsx'],
            reporter: ['text-summary', 'text'],
            thresholds: { lines: 90, branches: 90 },
        },
    },
});
