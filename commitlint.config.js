/** @type {import('@commitlint/types').UserConfig} */
export default {
    extends: ['@commitlint/config-conventional'],
    rules: {
        'scope-enum': [
            2,
            'always',
            [
                'relay',
                'dashboard',
                'engine-ui',
                'mock-engine',
                'protocol',
                'engine-api',
                'conformance',
                'ui',
                'e2e',
                'infra',
                'docs',
                'ci',
                'deps',
                'deps-dev',
                'repo',
            ],
        ],
    },
};
