import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';

import { apiRoutes } from '../../shared/api/routes';
import type { LicenseView } from '../../shared/api/routes';
import { ApiClientProvider } from '../api/api-client-context';
import { BrowserProvider } from '../core/browser';
import { WebsiteBillingPage } from '../features/website-billing/website-billing-page';
import type { WebsiteBillingConfig } from '../features/website-billing/website-links';
import { LocaleProvider } from '../i18n/locale';
import { createFakePasskeys } from './fake-passkeys';
import { NOW } from './fixtures';
import { createMemoryStorage } from './memory-storage';
import { APP_ORIGIN } from './render-app';
import { createScriptedApi, ok } from './scripted-api';

const DAY = 86_400_000;
const OK_CHECK = { outcome: 'ok', reason: null } as const;

export const WEBSITE_MANAGE_URL = 'https://www.ptbk.io/cs/ucet/predplatne';

/** A linked organization with one active grant, as `GET /api/license` answers it. */
export function websiteLicense(overrides: Partial<LicenseView> = {}): LicenseView {
    return {
        link: { linkedAt: NOW - 3 * DAY, linkedByEmail: 'ada@example.test' },
        state: 'current',
        status: 'active',
        label: 'Business (měsíčně)',
        term: { kind: 'ends', at: new Date(NOW + 30 * DAY).toISOString() },
        checkedAt: new Date(NOW - 3_600_000).toISOString(),
        manageUrl: WEBSITE_MANAGE_URL,
        grants: [
            {
                id: '4408b4d6-6005-4b77-97eb-fdd67847ee93',
                validFrom: new Date(NOW - 10 * DAY).toISOString(),
                validUntil: new Date(NOW + 30 * DAY).toISOString(),
                active: true,
                capabilities: {
                    engineProjects: 2,
                    specialists: 10,
                    controllingUsers: 5,
                    harnessInstances: null,
                    browserProfiles: 5,
                    remoteControl: true,
                },
            },
        ],
        coverage: { engines: { used: 1, covered: 1, capacity: 2 }, people: { used: 2, limit: 5 } },
        notice: null,
        enforcement: 'advisory',
        checks: { engineLink: OK_CHECK, memberInvite: OK_CHECK },
        ...overrides,
    };
}

/**
 * The website billing page on its own, with the providers `App` gives it, while no route renders it yet (#329). Once
 * `/billing` does, test it through `renderApp` instead.
 */
export function renderWebsiteBillingPage(
    license: LicenseView,
    config?: WebsiteBillingConfig,
): RenderResult & { readonly user: UserEvent; readonly navigations: readonly string[] } {
    const api = createScriptedApi().on(apiRoutes.getLicense, ok(license));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const navigations: string[] = [];
    const user = userEvent.setup();
    const result = render(
        <BrowserProvider
            browser={{
                storage: createMemoryStorage(),
                matchMedia: (query) => window.matchMedia(query),
                passkeys: createFakePasskeys(),
                now: () => NOW,
                origin: APP_ORIGIN,
                navigate: (url) => {
                    navigations.push(url);
                },
            }}
        >
            <LocaleProvider>
                <ApiClientProvider client={api}>
                    <QueryClientProvider client={queryClient}>
                        <WebsiteBillingPage {...(config === undefined ? {} : { config })} />
                    </QueryClientProvider>
                </ApiClientProvider>
            </LocaleProvider>
        </BrowserProvider>,
    );
    return { ...result, user, navigations };
}
