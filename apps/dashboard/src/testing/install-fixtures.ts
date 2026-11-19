import { installationOptions } from '../domain/registration/installation-options';

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

/** Published npm/desktop release checked on 19 November 2026; bootstrap bytes come from its immutable commit. */
export const TEST_ENGINE_INSTALLATION = {
    version: '0.119.0-117',
    windowsSha256: '944aa6f8c7a592806ec63d7943548048f53072e04349b88a783695afbb0e2c7a',
    bootstrapRevision: 'eda1a109787d164046d1f73732705e8a9afa76ec',
    bootstrapSha256: '8635addd31a056c97ffb234f07f9e845f57783923e185f3fb07f783d730288cd',
} as const;

/** The real issuer's presentation, for client tests without importing a domain module into the SPA. */
export function testInstallationOptions(link: string) {
    return installationOptions(TEST_ENGINE_INSTALLATION, link);
}
