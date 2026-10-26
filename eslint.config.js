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
/** The dashboard's CSP has `trusted-types 'none'`: no HTML sink can ever run there, so none may be written. */
const dashboardDomBans = engineUiDomBans.map((ban) =>
    ban.message === htmlSink
        ? {
              ...ban,
              message: "The dashboard's CSP sets trusted-types 'none': render through React, never an HTML sink.",
          }
        : ban,
);
/**
 * User-visible text lives in the message catalogues (engine-ui) or comes in through `UiMessages` and props (`@ptbk/ui`),
 * never as JSX text. Words that are never translated, such as the product name, are on the allowlist.
 */
const JSX_TEXT_ALLOWED = ['Promptbook'];
const jsxTextBan = {
    selector: `JSXText[value=/\\p{L}/u]:not([value=/^\\s*(${JSX_TEXT_ALLOWED.join('|')})\\s*$/u])`,
    message: 'User-visible text goes through the message catalogues (messages/*.json) or UiMessages, not JSX text.',
};
const uiPackageImports = [
    { group: ['@ptbk/*', '**/apps/**'], message: 'The design system imports no app and no contract package.' },
    {
        group: [
            '@tanstack/react-router',
            '@tanstack/react-router/*',
            '@tanstack/react-query',
            '@tanstack/react-query/*',
        ],
        message:
            'The design system is router- and data-agnostic: apps build router links from Anchor and own their queries.',
    },
];
const domainPatterns = [
    { group: ['node:*', 'cloudflare:*'], message: domainPurity },
    { group: ['**/adapters/**', '**/app/**'], message: domainPurity },
];
const gatewayPagesImports = {
    group: ['@ptbk/*', '**/apps/**'],
    message: 'The gateway pages are MIT and move public with the contracts (ADR 0002): they import nothing private.',
};
/** ADR 0014: release provenance is verified on `@sigstore/verify` directly, with exact identity matching. */
const sigstoreVerifyBan = {
    group: ['sigstore', 'sigstore/*'],
    message:
        "sigstore.verify() matches identities by unanchored pattern and compares raw DER; use @ptbk/release-tools' verifier.",
};

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
            'apps/engine-ui/src/paraglide/',
            'apps/dashboard/playwright-report/**',
            'apps/dashboard/test-results/**',
            'apps/engine-ui/playwright-report/**',
            'apps/engine-ui/test-results/**',
            'e2e/test-results/**',
            // Deliberately broken inputs for the token-boundary test.
            'packages/ui/test/fixtures/**',
            // Vendored byte for byte from @simplewebauthn/browser; a test pins its hash.
            'packages/gateway-pages/pages/simplewebauthn-browser.umd.min.js',
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
        // Node-only (it hosts the fake platform and runs the engine), but it moves public with the rest of the suite.
        files: ['packages/conformance/node/**/*.ts'],
        rules: restrictImports({
            group: ['@ptbk/*', '!@ptbk/protocol', '!@ptbk/engine-api'],
            message: 'The conformance suite imports only the contracts.',
        }),
    },
    {
        // Node-only, but like the contracts it may move public (ADR 0002), so it depends on nothing private.
        files: ['packages/release-tools/src/**/*.ts'],
        rules: restrictImports(sigstoreVerifyBan, {
            group: ['@ptbk/*', '!@ptbk/protocol'],
            message: 'release-tools imports only the protocol contracts.',
        }),
    },
    {
        files: ['apps/mock-engine/src/**/*.ts'],
        ignores: ['apps/mock-engine/src/domain/**'],
        rules: restrictImports(sigstoreVerifyBan),
    },
    {
        files: ['apps/mock-engine/src/domain/**/*.ts'],
        rules: restrictImports(...domainPatterns, sigstoreVerifyBan),
    },
    {
        files: ['packages/gateway-pages/src/**/*.ts'],
        ignores: ['**/*.test.ts', 'packages/gateway-pages/src/testing/**'],
        rules: restrictImports(platformImports, gatewayPagesImports),
    },
    {
        files: ['packages/gateway-pages/src/**/*.test.ts', 'packages/gateway-pages/src/testing/**/*.ts'],
        rules: restrictImports(gatewayPagesImports),
    },
    {
        // Served by the engine under ENGINE_UI_CSP and Trusted Types, to be copied as they are.
        files: ['packages/gateway-pages/pages/**/*.js'],
        languageOptions: { globals: globals.browser, sourceType: 'module' },
        rules: {
            ...restrictImports(gatewayPagesImports),
            'no-restricted-syntax': [
                'error',
                ...engineUiDomBans,
                { selector: "MemberExpression[property.name='style']", message: "`style-src 'self'`: use a class." },
                {
                    selector:
                        'CallExpression[callee.name=/^set(Timeout|Interval)$/][arguments.0.type=/^(Literal|TemplateLiteral|BinaryExpression)$/]',
                    message: dynamicCodeBan,
                },
            ],
        },
    },
    {
        files: ['packages/ui/src/**/*.{ts,tsx}'],
        extends: [reactHooks.configs.flat['recommended-latest'], jsxA11y.flatConfigs.recommended],
        languageOptions: { globals: globals.browser },
        rules: {
            ...restrictImports(platformImports, ...uiPackageImports),
            // Ships inside engine-ui, so the same CSP bans apply.
            'no-restricted-syntax': ['error', ...engineUiDomBans],
        },
    },
    {
        files: ['packages/ui/src/**/*.tsx'],
        // Tests and the gallery are developer tools with sample content; neither reaches a production bundle.
        ignores: ['**/*.test.tsx', '**/*.gallery.tsx', 'packages/ui/src/gallery.tsx'],
        rules: { 'no-restricted-syntax': ['error', ...engineUiDomBans, jsxTextBan] },
    },
    {
        files: ['packages/ui/test/**/*.ts'],
        rules: restrictImports(...uiPackageImports),
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
        files: ['apps/dashboard/src/client/**/*.{ts,tsx}'],
        extends: [reactHooks.configs.flat['recommended-latest'], jsxA11y.flatConfigs.recommended],
        languageOptions: { globals: globals.browser },
        rules: {
            'no-restricted-syntax': ['error', ...dashboardDomBans],
            // TanStack Router's guards throw `redirect()` and `notFound()`, which are not Error objects by design.
            '@typescript-eslint/only-throw-error': [
                'error',
                { allow: [{ from: 'package', package: '@tanstack/router-core', name: ['Redirect', 'NotFoundError'] }] },
            ],
        },
    },
    {
        files: ['apps/dashboard/src/client/**/*.tsx'],
        ignores: ['**/*.test.tsx', 'apps/dashboard/src/client/testing/**'],
        rules: {
            'no-restricted-syntax': [
                'error',
                ...dashboardDomBans,
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
        files: ['apps/engine-ui/src/**/*.tsx'],
        ignores: ['**/*.test.tsx', 'apps/engine-ui/src/testing/**'],
        rules: { 'no-restricted-syntax': ['error', ...engineUiDomBans, jsxTextBan] },
    },
    {
        // Playwright requires every fixture to destructure its first argument, even when it uses none.
        files: ['e2e/**/*.ts'],
        rules: { 'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }] },
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
