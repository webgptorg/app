import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const WORKERS_TESTS = ['src/**/*.workers.test.ts', 'src/adapters/db/**/*.test.ts'];

export default defineConfig(async () => {
    const migrations = await readD1Migrations('./migrations');
    return {
        test: {
            projects: [
                {
                    test: {
                        name: 'unit',
                        environment: 'node',
                        include: [
                            'src/{domain,app,adapters}/**/*.test.ts',
                            'scripts/**/*.test.ts',
                            'test/**/*.test.ts',
                        ],
                        exclude: WORKERS_TESTS,
                    },
                },
                {
                    // Runs the built Worker (`build` comes first in `test`), so headers and CSP are the production ones.
                    plugins: [cloudflareTest({ wrangler: { configPath: './dist/ptbk_dashboard/wrangler.json' } })],
                    test: {
                        name: 'workers',
                        include: WORKERS_TESTS,
                        setupFiles: ['./src/adapters/db/apply-test-migrations.ts'],
                        provide: { migrations },
                    },
                },
                {
                    plugins: [react()],
                    test: {
                        name: 'client',
                        environment: 'jsdom',
                        include: ['src/client/**/*.test.{ts,tsx}'],
                    },
                },
            ],
        },
    };
});
