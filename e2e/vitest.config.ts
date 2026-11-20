import { defineConfig } from 'vitest/config';

// Only the harness helpers: `bun run check` must never need Docker. Browser tests are Playwright's (tests/**/*.spec.ts).
export default defineConfig({
    test: {
        include: ['src/**/*.test.ts', 'init/**/*.test.ts', 'real-engine/**/*.test.ts'],
    },
});
