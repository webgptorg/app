import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const dynamicCodeBan = 'Dynamic code execution is banned (spec, Security hardening).';
const domainPurity = 'Domain code is pure: depend on a port (interface), and wire the adapter in the composition root.';
const portable =
    'Shared contracts must run in Node, Workers and browsers: use Web APIs (fetch, crypto.subtle, streams).';

/**
 * Flat config replaces, not merges, a rule set in a later block. Every area-specific
 * `no-restricted-imports` must go through this helper so the vm ban always stays on, and a
 * block whose files overlap another area (e.g. a dashboard rule covering `src/domain/**`)
 * must pass that area's patterns too, such as `...domainPatterns`.
 */
function restrictImports(...patterns) {
    return {
        'no-restricted-imports': [
            'error',
            {
                paths: [
                    { name: 'vm', message: dynamicCodeBan },
                    { name: 'node:vm', message: dynamicCodeBan },
                ],
                patterns,
            },
        ],
    };
}

const platformImports = { group: ['node:*', 'cloudflare:*', 'bun:*'], message: portable };
const domainPatterns = [
    { group: ['node:*', 'cloudflare:*'], message: domainPurity },
    { group: ['**/adapters/**', '**/app/**'], message: domainPurity },
];

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
            ...restrictImports(),
            'no-restricted-exports': ['error', { restrictDefaultExports: { direct: true } }],
            '@typescript-eslint/consistent-type-imports': 'error',
            '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
            '@typescript-eslint/switch-exhaustiveness-check': 'error',
            'no-restricted-properties': [
                'error',
                { object: 'Math', property: 'random', message: 'Use the Random port (crypto.getRandomValues).' },
            ],
        },
    },
    {
        files: ['apps/*/src/domain/**/*.{ts,tsx}'],
        rules: restrictImports(...domainPatterns),
    },
    {
        files: ['packages/protocol/src/**/*.ts', 'packages/engine-api/src/**/*.ts'],
        rules: restrictImports(platformImports, { group: ['@ptbk/*'], message: portable }),
    },
    {
        files: ['packages/conformance/src/**/*.ts'],
        rules: restrictImports(platformImports, {
            group: ['@ptbk/*', '!@ptbk/protocol', '!@ptbk/engine-api'],
            message: 'The conformance suite imports only the contracts.',
        }),
    },
    {
        files: ['packages/ui/src/**/*.{ts,tsx}'],
        rules: restrictImports(platformImports, {
            group: ['@ptbk/*'],
            message: 'The design system imports no app and no contract package.',
        }),
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
