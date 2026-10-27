/** The install vars every test configuration uses: wrangler.jsonc's dev tabs, with a test guide address. */
export const TEST_INSTALL_VARS = {
    INSTALL_COMMANDS: [
        {
            id: 'installer',
            labelKey: 'docker-server',
            template: 'bun run dev:link {linkCode}',
            docsAnchor: '1-the-installer-recommended',
        },
        {
            id: 'compose',
            labelKey: 'docker-compose',
            template:
                'docker compose run --rm engine promptbook-engine connect --link {linkCode}\ndocker compose up -d\ndocker compose exec engine promptbook-engine setup-link',
            docsAnchor: '2-docker-compose',
        },
        {
            id: 'connect',
            labelKey: 'already-running',
            template: 'docker compose -p ptbk-dev exec mock-engine node /app/main.mjs connect --link {linkCode}',
            docsAnchor: '3-link-an-engine-that-already-runs',
        },
    ],
    INSTALL_GUIDE_URL: 'https://docs.ptbk.test/engine/installation',
} as const;
