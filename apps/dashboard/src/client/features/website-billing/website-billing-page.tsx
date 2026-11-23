import { Banner, ErrorState, ExternalLink, Section, Skeleton } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';

import { m } from '../../../paraglide/messages';
import { useApiClient } from '../../api/api-client-context';
import { licenseQuery } from '../../api/queries';
import { useLocale } from '../../i18n/locale';
import { LicenseStatusSection } from '../licensing/license-page';
import { DEFAULT_WEBSITE_BILLING_CONFIG, planLabelFor, websiteBillingLinks } from './website-links';
import type { WebsiteBillingConfig, WebsiteBillingLinks } from './website-links';

function LinksToWebsite(props: { readonly links: WebsiteBillingLinks }) {
    const { buy, manage, invoices } = props.links;
    return (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            {buy === null ? null : <ExternalLink href={buy}>{m.license_buy_action()}</ExternalLink>}
            {manage === null ? null : <ExternalLink href={manage}>{m.license_manage_action()}</ExternalLink>}
            {invoices === null ? null : (
                <ExternalLink href={invoices}>{m.website_billing_invoices_action()}</ExternalLink>
            )}
        </div>
    );
}

/** Said on every state, a licence or none: what changes without one is nothing. */
function AdvisorySection() {
    return (
        <Section title={m.website_billing_advisory_title()}>
            <p className="text-sm">{m.website_billing_advisory_body()}</p>
            <p className="text-sm text-text-muted">{m.website_billing_payments_body()}</p>
        </Section>
    );
}

/**
 * Billing with `ADAPTERS.billing = website` (ADR 0021, #329): the licence card with buy, manage and invoices links to
 * ptbk.io, and what a licence changes. It sells nothing and blocks nothing. Not routed yet: see this module's README.
 */
export function WebsiteBillingPage(props: { readonly config?: WebsiteBillingConfig }) {
    const config = props.config ?? DEFAULT_WEBSITE_BILLING_CONFIG;
    const api = useApiClient();
    const { locale } = useLocale();
    const license = useQuery(licenseQuery(api));

    function content() {
        if (license.isPending) {
            return (
                <div>
                    <span className="sr-only">{m.loading()}</span>
                    <Skeleton className="h-40 w-full" />
                </div>
            );
        }
        if (license.isError) {
            return (
                <ErrorState
                    message={m.license_error()}
                    onRetry={() => void license.refetch()}
                    retrying={license.isFetching}
                />
            );
        }
        const view = license.data;
        const links = websiteBillingLinks({ config, locale, license: view });
        return (
            <>
                {view.state === 'stale' ? (
                    <Banner tone="info" title={m.license_stale_title()}>
                        {m.license_stale_body()}
                    </Banner>
                ) : null}
                <LicenseStatusSection
                    license={{ ...view, label: planLabelFor(view.label, locale, config) }}
                    actions={<LinksToWebsite links={links} />}
                />
            </>
        );
    }

    return (
        <div className="flex max-w-3xl flex-col gap-6">
            <div className="flex flex-col gap-2">
                <h1 className="font-display text-2xl font-semibold">{m.billing_title()}</h1>
                <p className="text-text-muted">{m.website_billing_intro()}</p>
            </div>
            {content()}
            <AdvisorySection />
        </div>
    );
}
