import type { Hono } from 'hono';

import type { LicenseCheck } from '../../domain/licensing/license-checks';
import type { LicenseService } from '../../domain/licensing/license-service';
import {
    createWebsiteAccessFlows,
    HANDOFF_STATE_TTL_MS,
    PENDING_LINK_TTL_MS,
} from '../../domain/licensing/website-access';
import { apiRoutes, type WebsiteAccessError } from '../../shared/api/routes';
import type { BillingConfig } from '../config';
import type { DashboardDeps } from '../deps';
import type { RouteBinder } from './bind-route';
import {
    clearWebsiteLinkCookie,
    clearWebsiteStateCookie,
    WEBSITE_LINK_COOKIE,
    WEBSITE_STATE_COOKIE,
    websiteLinkCookie,
    websiteStateCookie,
} from './cookies';

type WebsiteBilling = Extract<BillingConfig, { readonly adapter: 'website' }>;

/**
 * Where "Buy on ptbk.io" goes without a licence to read a manage link from: the page the website's own manage links
 * point at today.
 */
const WEBSITE_PRICING_PATH = '/cs/pricing/predplatne';

/**
 * D-30's routes (ADR 0021): the website handoff and the advisory licence view. The website only ever proves a mailbox;
 * an App account is still made by the App's own email link and passkey, and only its owner or admin links it.
 */
export function bindLicensingRoutes(
    router: Hono,
    mount: string,
    deps: Pick<DashboardDeps, 'clock' | 'random' | 'logger' | 'store' | 'config'> & {
        readonly website: WebsiteBilling;
        readonly licensing: NonNullable<DashboardDeps['licensing']>;
        readonly licenses: LicenseService;
        readonly routes: RouteBinder;
    },
): void {
    const { website, licensing, clock } = deps;
    const bind = deps.routes.bind.bind(deps.routes);
    const flows = createWebsiteAccessFlows({
        clock,
        random: deps.random,
        handoffs: licensing.store,
        websiteLinks: licensing.store,
        exchange: licensing.identities,
        accounts: deps.store.accounts,
    });
    const pricingUrl = `${website.websiteOrigin}${WEBSITE_PRICING_PATH}`;
    const accessPage = (error?: WebsiteAccessError) =>
        `${deps.config.dashboardOrigin}/website-access${error === undefined ? '' : `?error=${error}`}`;

    // Also where the website's "Open app" link should point: the state cookie must exist on this origin before any
    // identity comes back to it.
    bind(router, mount, apiRoutes.websiteAccessStart, async () => {
        const { challenge } = await flows.start();
        const location = new URL(website.handoffUrl);
        location.searchParams.set('challenge', challenge);
        return {
            kind: 'redirect',
            location: location.href,
            setCookies: [websiteStateCookie(challenge, HANDOFF_STATE_TTL_MS)],
        };
    });

    bind(router, mount, apiRoutes.websiteAccessReturn, async ({ input, request }) => {
        const outcome = await flows.complete(
            { code: input.query.code, challenge: request.secretCookie(WEBSITE_STATE_COOKIE) },
            request.signal,
        );
        deps.logger.info('website-access.return', { outcome: outcome.kind });
        switch (outcome.kind) {
            case 'pending':
                return {
                    kind: 'redirect',
                    location: accessPage(),
                    setCookies: [clearWebsiteStateCookie(), websiteLinkCookie(outcome.token, PENDING_LINK_TTL_MS)],
                };
            case 'state-invalid':
                return { kind: 'redirect', location: accessPage('expired'), setCookies: [clearWebsiteStateCookie()] };
            case 'exchange-failed':
                return { kind: 'redirect', location: accessPage('failed'), setCookies: [clearWebsiteStateCookie()] };
        }
    });

    bind(router, mount, apiRoutes.websiteAccessPending, async ({ request }) => {
        const pending = await flows.pending(request.secretCookie(WEBSITE_LINK_COOKIE));
        return pending.kind === 'none'
            ? { kind: 'problem', status: 404, code: 'not-found', setCookies: [clearWebsiteLinkCookie()] }
            : {
                  kind: 'ok',
                  body: { email: pending.email, accountExists: pending.accountExists, expiresAt: pending.expiresAt },
              };
    });

    bind(router, mount, apiRoutes.websiteAccessLink, async ({ request, session }) => {
        const outcome = await flows.link({
            token: request.secretCookie(WEBSITE_LINK_COOKIE),
            actor: { userId: session.user.id, email: session.user.email, orgId: session.actor.orgId },
        });
        deps.logger.info('website-access.link', { outcome, orgId: session.actor.orgId });
        switch (outcome) {
            case 'linked':
                return { kind: 'ok', body: { linked: true } as const, setCookies: [clearWebsiteLinkCookie()] };
            case 'pending-invalid':
                return {
                    kind: 'problem',
                    status: 404,
                    code: 'pending-invalid',
                    setCookies: [clearWebsiteLinkCookie()],
                };
            case 'email-mismatch':
                return { kind: 'problem', status: 409, code: 'email-mismatch' };
            case 'conflict':
                return { kind: 'problem', status: 409, code: 'website-link-conflict' };
        }
    });

    // Read on demand when the License and Engines screens load; the reader refreshes past `refreshAfterSeconds` and
    // keeps the last snapshot when the website does not answer within 5 seconds.
    bind(router, mount, apiRoutes.getLicense, async ({ request, session }) => {
        const { link, summary, checks } = await deps.licenses.overview(session.actor.orgId, request.signal);
        return {
            kind: 'ok',
            body: {
                link: link === null ? null : { linkedAt: link.linkedAt, linkedByEmail: link.linkedByEmail },
                ...summary,
                manageUrl: summary.manageUrl ?? pricingUrl,
                grants: summary.grants.map((grant) => ({
                    id: grant.id,
                    validFrom: grant.validFrom,
                    validUntil: grant.validUntil,
                    active: grant.active,
                    capabilities: { ...grant.capabilities },
                })),
                enforcement: website.enforcement,
                checks: {
                    engineLink: checkView(checks['engine.link']),
                    memberInvite: checkView(checks['member.invite']),
                },
            },
        };
    });
}

function checkView(check: LicenseCheck) {
    return check.outcome === 'ok' ? { outcome: check.outcome, reason: null } : check;
}
