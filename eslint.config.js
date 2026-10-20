import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
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
const dashboardClientOnly = {
    group: ['**/client/**', 'react', 'react-dom', 'react-dom/*', '@tanstack/react-*'],
    message: 'Worker code never imports the SPA.',
};
const drizzleOnlyInDbAdapter = {
    group: ['drizzle-orm', 'drizzle-orm/*'],
    message: 'Drizzle lives only in src/adapters/db/ (ADR 0009); depend on a repository port.',
};
const htmlSink =
    'engine-ui runs under Trusted Types: HTML goes only through src/security/trusted-html.ts (U-05), never a raw sink.';
/**
 * The engine's CSP (rule 4) refuses these at runtime; lint catches them before a browser does. One array, so a later
 * engine-ui `no-restricted-syntax` block spreads it instead of replacing it.
 */
const engineUiDomBans = [
    { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: htmlSink },
    { selector: 'MemberExpression[property.name=/^(innerHTML|outerHTML)$/]', message: htmlSink },
    { selector: 'MemberExpression[computed=true][property.value=/^(innerHTML|outerHTML)$/]', message: htmlSink },
    { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: htmlSink },
    { selector: "MemberExpression[object.name='document'][property.name=/^(write|writeln)$/]", message: htmlSink },
    {
        selector: "CallExpression[callee.property.name='setAttribute'][arguments.0.value='style']",
        message:
            "`style-src 'self'` blocks style attributes set as strings; use a class or React's style prop (CSSOM).",
    },
    {
        selector: 'NewExpression[callee.name=/^(Shared)?Worker$/][arguments.0.type=/^(Literal|TemplateLiteral)$/]',
        message:
            "Load workers from a bundled module: new Worker(new URL('./x.ts', import.meta.url), { type: 'module' }).",
    },
];
const domainPatterns = [
    { group: ['node:*', 'cloudflare:*'], message: domainPurity },
    { group: ['**/adapters/**', '**/app/**'], message: domainPurity },
];

export default tseslint.config(
    {
        ignores: [
            '**/dist/**',
            '**/build/**',
            '**/coverage/**',
            '**/.wrangler/**',
            'docs/spec/**',
            '**/routeTree.gen.ts',
            '**/worker-configuration.d.ts',
            'apps/dashboard/src/paraglide/',
            'apps/engine-ui/playwright-report/**',
            'apps/engine-ui/test-results/**',
        ],
    },
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
        rules: {
            ...restrictImports(platformImports, { group: ['@ptbk/*'], message: portable }),
            // The contracts compile against DOM typings for crypto.subtle; this keeps browser-only globals out.
            'no-restricted-globals': [
                'error',
                ...['window', 'document', 'localStorage'].map((name) => ({ name, message: portable })),
            ],
        },
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
        files: [
            'apps/dashboard/src/worker.ts',
            'apps/dashboard/src/app/**/*.ts',
            'apps/dashboard/src/adapters/**/*.ts',
        ],
        ignores: ['apps/dashboard/src/adapters/db/**'],
        rules: restrictImports(dashboardClientOnly, drizzleOnlyInDbAdapter),
    },
    {
        files: ['apps/dashboard/src/domain/**/*.ts'],
        rules: restrictImports(...domainPatterns, dashboardClientOnly, drizzleOnlyInDbAdapter),
    },
    {
        files: ['apps/dashboard/src/adapters/db/**/*.ts'],
        rules: {
            ...restrictImports(dashboardClientOnly),
            // The relational query API changes in Drizzle 1.0 (ADR 0009); the core query builder is enough.
            'no-restricted-syntax': [
                'error',
                {
                    selector: "MemberExpression[property.name='query']",
                    message: 'Use the core query builder, not db.query.',
                },
                {
                    selector: "ImportSpecifier[imported.name='relations']",
                    message: 'The relational query API is banned until Drizzle 1.0.',
                },
            ],
        },
    },
    {
        files: ['apps/dashboard/src/shared/**/*.ts'],
        rules: restrictImports(drizzleOnlyInDbAdapter, {
            group: ['**/app/**', '**/domain/**', '**/adapters/**', '**/client/**', 'hono', 'hono/*', 'react'],
            message: 'Shared API contracts are plain zod, used by both the Worker and the SPA.',
        }),
    },
    {
        files: ['apps/dashboard/src/client/**/*.{ts,tsx}'],
        rules: restrictImports(platformImports, drizzleOnlyInDbAdapter, {
            group: [
                '**/app/**',
                '**/domain/**',
                '**/adapters/**',
                '**/worker',
                'hono',
                'hono/*',
                '@ptbk/*',
                '!@ptbk/ui',
                '!@ptbk/protocol',
            ],
            message:
                'The SPA imports only src/client, src/shared, the generated messages, @ptbk/ui and @ptbk/protocol.',
        }),
    },
    {
        files: ['apps/dashboard/src/client/**/*.tsx'],
        ignores: ['**/*.test.tsx'],
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector: 'JSXText[value=/\\p{L}/u]',
                    message: 'User-facing text goes through the message catalogues (messages/*.json).',
                },
            ],
        },
    },
    {
        files: ['apps/engine-ui/src/**/*.{ts,tsx}'],
        extends: [reactHooks.configs.flat['recommended-latest'], jsxA11y.flatConfigs.recommended],
        languageOptions: { globals: globals.browser },
    },
    {
        files: ['apps/engine-ui/**/*.{ts,tsx}'],
        // The one module allowed to create TrustedHTML (U-05).
        ignores: ['apps/engine-ui/src/security/trusted-html.ts'],
        rules: { 'no-restricted-syntax': ['error', ...engineUiDomBans] },
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
