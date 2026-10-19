import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const dynamicCodeBan = 'Dynamic code execution is banned (spec, Security hardening).';
const domainPurity = 'Domain code is pure: depend on a port (interface), and wire the adapter in the composition root.';
const portable =
    'Shared contracts must run in Node, Workers and browsers: use Web APIs (fetch, crypto.subtle, streams).';

export default tseslint.config(
    { ignores: ['**/dist/**', '**/build/**', '**/coverage/**', '**/.wrangler/**', 'docs/spec/**'] },
    js.configs.recommended,
    tseslint.configs.strictTypeChecked,
    {
        languageOptions: {
            globals: globals.node,
            parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
        },
        rules: {
            'no-eval': 'error',
            'no-new-func': 'error',
            '@typescript-eslint/no-implied-eval': 'error',
            'no-restricted-imports': [
                'error',
                {
                    paths: [
                        { name: 'vm', message: dynamicCodeBan },
                        { name: 'node:vm', message: dynamicCodeBan },
                    ],
                },
            ],
            'no-restricted-exports': ['error', { restrictDefaultExports: { direct: true } }],
            '@typescript-eslint/consistent-type-imports': 'error',
            '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
            '@typescript-eslint/switch-exhaustiveness-check': 'error',
        },
    },
    {
        files: ['apps/*/src/domain/**/*.ts'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    paths: [
                        { name: 'vm', message: dynamicCodeBan },
                        { name: 'node:vm', message: dynamicCodeBan },
                    ],
                    patterns: [
                        { group: ['node:*', 'cloudflare:*'], message: domainPurity },
                        { group: ['**/adapters/**', '**/app/**'], message: domainPurity },
                    ],
                },
            ],
        },
    },
    {
        files: ['packages/protocol/src/**/*.ts', 'packages/engine-api/src/**/*.ts'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    paths: [
                        { name: 'vm', message: dynamicCodeBan },
                        { name: 'node:vm', message: dynamicCodeBan },
                    ],
                    patterns: [{ group: ['node:*', 'cloudflare:*', 'bun:*', '@ptbk/*'], message: portable }],
                },
            ],
        },
    },
    {
        files: ['packages/ui/src/**/*.{ts,tsx}'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    paths: [
                        { name: 'vm', message: dynamicCodeBan },
                        { name: 'node:vm', message: dynamicCodeBan },
                    ],
                    patterns: [
                        { group: ['@ptbk/*'], message: 'The design system imports no app and no contract package.' },
                        { group: ['node:*', 'cloudflare:*', 'bun:*'], message: portable },
                    ],
                },
            ],
        },
    },
    {
        // Frameworks and runtimes require a default export here.
        files: ['**/*.config.{js,ts}', 'apps/*/src/worker.ts', 'apps/*/src/routes/**'],
        rules: { 'no-restricted-exports': 'off' },
    },
    {
        files: ['**/*.js'],
        extends: [tseslint.configs.disableTypeChecked],
    },
    prettier,
);
