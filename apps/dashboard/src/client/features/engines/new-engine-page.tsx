import {
    Banner,
    Button,
    CopyButton,
    ErrorState,
    ExternalLink,
    Section,
    Skeleton,
    Tabs,
    useLocale,
    useToast,
} from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';

import { m } from '../../../paraglide/messages';
import { apiRoutes, type LinkCodeView, type SessionView } from '../../../shared/api/routes';
import { isVpsProvider, type VpsProviderId } from '../../../shared/vps';
import type { InstallPathLabelKey } from '../../../shared/install-paths';
import { useApiClient } from '../../api/api-client-context';
import { billingQuery, dataOrThrow, problemCode } from '../../api/queries';
import { useBrowser } from '../../core/browser';
import { Link } from '../../core/link';
import { useAppMutation } from '../../core/mutations';
import { useSession } from '../session/use-session';
import { Crumb, Page } from '../shell/page';
import { TrustLink } from '../trust/trust-link';
import { troubleshootingLink } from './engine-guide';
import { LinkProgress, useObservedLink } from './link-progress';
import type { ObservedLink } from './link-progress';
import { LINK_POLL_MS, linkCodeQuery, linkEligibilityQuery } from './link-queries';
import { canKeepOwnerSetupSecret, drawOwnerSetup, keepOwnerSetupSecret } from './owner-handoff';
import { LinkSteps } from './link-steps';
import { InstallationCopyBlock } from './installation-copy-block';
import { installationTabs } from './installation-options';
import type { LinkStep } from './link-steps';

const NewEnginePlanStep = lazy(async () => {
    const module = await import('./new-engine-plan-step');
    return { default: module.NewEnginePlanStep };
});

/** Only with website licences, so dashboards without them never load it. */
const LicenseCheckNotice = lazy(async () => ({
    default: (await import('../licensing/license-check-notice')).LicenseCheckNotice,
}));

const VpsButtons = lazy(async () => ({ default: (await import('./vps-launch')).VpsButtons }));
const VpsProgress = lazy(async () => ({ default: (await import('./vps-launch')).VpsProgress }));

const LINK_PERMISSION = 'engine.link';
const BILLING_PERMISSION = 'billing.manage';
const SECOND_MS = 1000;
const MOVING_ANCHOR = 'moving-an-existing-deployment';

const INSTALL_PATH_LABELS: Record<InstallPathLabelKey, () => string> = {
    'docker-server': () => m.engines_new_tab_docker_server(),
    'docker-compose': () => m.engines_new_tab_docker_compose(),
    'already-running': () => m.engines_new_tab_already_running(),
    'new-project': () => m.engines_new_tab_new_project(),
};

type InstallCommandView = LinkCodeView['installCommands'][number];

export type CheckoutReturn = 'success' | 'cancel';

export interface NewEngineSearch {
    /** A link code's ID (not the code): the page shows that code's progress, after a reload too. */
    readonly link?: string;
    readonly checkout?: CheckoutReturn;
    readonly vps?: VpsProviderId;
    /** The team the new engine joins (ADR 0018); without it the engine gets a team of its own. */
    readonly team?: string;
}

const LINK_CODE_ID = /^[a-z2-7]{26}$/;

/** `link` is a link code's ID from issuance; `checkout` is set by the Checkout return URLs. Anything else is dropped. */
export function parseNewEngineSearch(search: Readonly<Record<string, unknown>>): NewEngineSearch {
    const { link, checkout, team, vps } = search;
    return {
        ...(typeof link === 'string' && LINK_CODE_ID.test(link) ? { link } : {}),
        ...(typeof team === 'string' && LINK_CODE_ID.test(team) ? { team } : {}),
        ...(isVpsProvider(vps) ? { vps } : {}),
        ...(checkout === 'success' || checkout === 'cancel' ? { checkout } : {}),
    };
}

type UpgradeReason = 'not-entitled' | 'engine-limit';

const LINK_CODE_LIMIT = 'link-code-limit';

function upgradeReason(error: unknown): UpgradeReason | null {
    const code = problemCode(error);
    return code === 'not-entitled' || code === 'engine-limit' ? code : null;
}

/**
 * With billing off there is no plan to upgrade, so the copy names the account and points nowhere. With website licences
 * these appear only under `LICENSE_ENFORCEMENT` `enforce`, and point to the licence instead.
 */
const UPGRADE_COPY: Record<
    'on' | 'off' | 'license',
    Record<UpgradeReason, { title: () => string; body: () => string }>
> = {
    on: {
        'not-entitled': {
            title: () => m.engines_new_not_entitled_title(),
            body: () => m.engines_new_not_entitled_body(),
        },
        'engine-limit': {
            title: () => m.engines_new_engine_limit_title(),
            body: () => m.engines_new_engine_limit_body(),
        },
    },
    off: {
        'not-entitled': {
            title: () => m.engines_new_not_entitled_off_title(),
            body: () => m.engines_new_not_entitled_off_body(),
        },
        'engine-limit': {
            title: () => m.engines_new_engine_limit_off_title(),
            body: () => m.engines_new_engine_limit_off_body(),
        },
    },
    license: {
        'not-entitled': {
            title: () => m.engines_new_license_missing_title(),
            body: () => m.engines_new_license_body(),
        },
        'engine-limit': {
            title: () => m.engines_new_license_limit_title(),
            body: () => m.engines_new_license_body(),
        },
    },
};

function upgradeCopy(
    session: { readonly billingEnabled: boolean; readonly licensing: boolean },
    reason: UpgradeReason,
) {
    return UPGRADE_COPY[session.licensing ? 'license' : session.billingEnabled ? 'on' : 'off'][reason];
}

/** Ticks every second from the injected clock, so the expiry banner shows when the code runs out on an open page. */
function useRemainingMs(until: number): number {
    const { now } = useBrowser();
    const [current, setCurrent] = useState(now);
    useEffect(() => {
        const timer = setInterval(() => {
            setCurrent(now());
        }, SECOND_MS);
        return () => {
            clearInterval(timer);
        };
    }, [now]);
    return Math.max(0, until - current);
}

function UpgradeBanner(props: { readonly reason: UpgradeReason }) {
    const session = useSession();
    const copy = upgradeCopy(session, props.reason);
    return (
        <Banner tone="warning" title={copy.title()}>
            <p>{copy.body()}</p>
            {session.billingEnabled ? <Link to="/billing">{m.engines_new_upgrade()}</Link> : null}
            {session.licensing ? <Link to="/license">{m.license_notice_action()}</Link> : null}
        </Banner>
    );
}

/** Codes live for weeks, so the way out is cancelling an unused one rather than waiting. */
function CodeLimitBanner() {
    return (
        <Banner tone="warning" title={m.engines_new_code_limit_title()}>
            <p>{m.engines_new_code_limit_body()}</p>
            <Link to="/engines">{m.engines_new_code_limit_action()}</Link>
        </Banner>
    );
}

function guideLink(guideUrl: string, anchor: string): string {
    return `${guideUrl}#${anchor}`;
}

function InstallPathPanel(props: {
    readonly path: InstallCommandView;
    readonly guideUrl: string;
    readonly linkUrl: string | null;
}) {
    const { path, guideUrl, linkUrl } = props;
    return (
        <div className="flex flex-col gap-3">
            <InstallationCopyBlock value={path.command} />
            {linkUrl === null ? null : <LinkUrl url={linkUrl} />}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <ExternalLink href={guideLink(guideUrl, path.docsAnchor)}>{m.engines_new_docs()}</ExternalLink>
                {path.id === 'connect' ? (
                    <ExternalLink href={guideLink(guideUrl, MOVING_ANCHOR)}>{m.engines_new_move_docs()}</ExternalLink>
                ) : null}
            </div>
        </div>
    );
}

/** The link URL on its own, for engines set up some other way than the tabs show; it names this dashboard. */
function LinkUrl(props: { readonly url: string }) {
    return (
        <div className="flex flex-col gap-2">
            <p className="text-sm">{m.engines_new_link_url()}</p>
            <div className="flex items-center gap-2 rounded-control border border-hairline bg-(--code-text-bg) py-1 pr-2 pl-3 text-(--code-text-text)">
                <span className="min-w-0 flex-1 font-mono text-sm wrap-anywhere">{props.url}</span>
                <CopyButton value={props.url} label={m.engines_new_copy_link()} variant="secondary" showLabel />
            </div>
        </div>
    );
}

function ExpiredBanner(props: { readonly onRenew: () => void; readonly renewing: boolean }) {
    return (
        <Banner tone="warning" title={m.engines_new_expired_title()}>
            <p>{m.engines_new_expired_body()}</p>
            <Button variant="secondary" loading={props.renewing} onClick={props.onRenew}>
                {m.engines_new_create_again()}
            </Button>
        </Banner>
    );
}

/**
 * Shown once: the code lives only in this component's state and is never fetched again. It goes when the code is used
 * (the countdown stops at "linked") and turns into the expiry banner when it runs out.
 */
function InstallCommand(props: {
    readonly view: LinkCodeView;
    readonly onRenew: () => void;
    readonly renewing: boolean;
}) {
    const api = useApiClient();
    const locale = useLocale();
    const remaining = useRemainingMs(props.view.expiresAt);
    const paths = props.view.installCommands;
    const options = props.view.installationOptions;
    const [selectedId, setSelectedId] = useState<string>(() => {
        if (options === undefined) return paths[0]?.id ?? '';
        return /Windows/i.test(navigator.userAgent) ? 'powershell' : 'posix';
    });
    // Only observes what the progress panel polls; it never asks on its own.
    const status = useQuery({ ...linkCodeQuery(api, props.view.linkCodeId), enabled: false }).data?.status;
    if (status === 'linked') {
        return null;
    }
    if (remaining === 0 || status === 'expired') {
        return <ExpiredBanner onRenew={props.onRenew} renewing={props.renewing} />;
    }
    const linkInConnectTab = options !== undefined && paths.some((path) => path.id === 'connect');
    const configuredTabs = paths
        .filter((path) => options === undefined || path.id !== 'installer')
        .map((path) => ({
            id: path.id,
            label: INSTALL_PATH_LABELS[path.labelKey](),
            panel: (
                <InstallPathPanel
                    path={path}
                    guideUrl={props.view.installGuideUrl}
                    linkUrl={linkInConnectTab && path.id === 'connect' ? props.view.linkUrl : null}
                />
            ),
        }));

    return (
        <>
            {props.view.vpsProviders?.length ? (
                <Suspense fallback={null}>
                    <VpsButtons offers={props.view.vpsProviders} link={props.view.linkCodeId} />
                </Suspense>
            ) : null}
            <Section
                title={m.engines_new_command_title()}
                divided={false}
                description={options === undefined ? m.engines_new_intro() : m.engines_new_install_intro()}
            >
                <div className="flex flex-col gap-3">
                    <Tabs
                        label={m.engines_new_tabs_label()}
                        selectedId={selectedId}
                        onSelect={setSelectedId}
                        tabs={
                            options === undefined
                                ? configuredTabs
                                : installationTabs(options, configuredTabs, locale.locale)
                        }
                    />
                    {!linkInConnectTab && props.view.linkUrl !== null ? <LinkUrl url={props.view.linkUrl} /> : null}
                    <p className="text-sm text-text-muted" aria-live="off">
                        {m.engines_new_command_body({ time: locale.formatDateTime(new Date(props.view.expiresAt)) })}
                    </p>
                    {options === undefined ? null : (
                        <p className="text-sm text-text-muted">{m.engines_new_computer_access()}</p>
                    )}
                </div>
            </Section>
        </>
    );
}

/** Only while the dashboard charges, and only for whoever manages billing. */
function canChoosePlan(session: SessionView): boolean {
    return session.billingEnabled && session.activeOrg.permissions.includes(BILLING_PERMISSION);
}

/** Load the existing legacy billing UI only for an eligible account that actually needs it. */
function PlanStep(props: { readonly checkout: CheckoutReturn | undefined }) {
    const session = useSession();
    if (!canChoosePlan(session)) return <UpgradeBanner reason="not-entitled" />;
    return (
        <Suspense fallback={<Skeleton className="h-32 w-full" />}>
            <NewEnginePlanStep checkout={props.checkout} />
        </Suspense>
    );
}

/** Back from Checkout: the subscription may reach us a moment after the browser does (the webhook). */
function CheckoutPending() {
    return (
        <div className="flex flex-col gap-3">
            <p role="status">{m.engines_new_checkout_pending()}</p>
            <Skeleton className="h-24 w-full" />
        </div>
    );
}

/**
 * The steps this visit shows. Plan appears only for an organization that had to choose one here: on arrival without a
 * plan, or back from Checkout.
 */
function flowSteps(planShown: boolean): readonly LinkStep[] {
    return planShown ? ['plan', 'install', 'connect', 'finish'] : ['install', 'connect', 'finish'];
}

function currentStep(planStep: boolean, link: ObservedLink | undefined): LinkStep | null {
    if (planStep) {
        return 'plan';
    }
    switch (link?.state) {
        case undefined:
        case 'waiting':
        case 'expired':
            return 'install';
        case 'linked':
            return 'connect';
        case 'owner-pending':
            return 'finish';
        case 'ready':
            return link.setupPending ? 'finish' : null;
    }
}

function LinkFlow(props: { readonly search: NewEngineSearch }) {
    const api = useApiClient();
    const session = useSession();
    const navigate = useNavigate();
    const toast = useToast();
    const browser = useBrowser();
    // Only to say "trial" or "subscription" in the thanks after Checkout.
    const billing = useQuery({ ...billingQuery(api), enabled: props.search.checkout === 'success' });
    const [issued, setIssued] = useState<LinkCodeView | null>(null);
    const create = useAppMutation<LinkCodeView>({
        // The owner setup secret (ADR 0023) lives only in this closure and the tab's sessionStorage; the request carries
        // its commitment. Without storage there could be no redirect, so no commitment either.
        mutationFn: async () => {
            const tab = browser.sessionStorage;
            const handoff = canKeepOwnerSetupSecret(tab) ? await drawOwnerSetup() : null;
            const body = handoff === null ? undefined : { ownerSetupCommitment: handoff.commitment };
            const view =
                props.search.team === undefined
                    ? dataOrThrow(await api.call(apiRoutes.createLinkCode, { body }))
                    : dataOrThrow(
                          await api.call(apiRoutes.createTeamLinkCode, { params: { teamId: props.search.team }, body }),
                      );
            if (handoff !== null && tab !== undefined) {
                keepOwnerSetupSecret(tab, view.linkCodeId, handoff.secret, issued?.linkCodeId ?? props.search.link);
            }
            return view;
        },
        errorMessage: (error) => {
            if (problemCode(error) === LINK_CODE_LIMIT) {
                return m.engines_new_code_limit_title();
            }
            const reason = upgradeReason(error);
            return reason === null ? undefined : upgradeCopy(session, reason).title();
        },
        onSuccess: async (view) => {
            setIssued(view);
            // Thanked once, here; the URL drops `checkout`, so a reload or a bookmark does not thank again.
            if (props.search.checkout === 'success') {
                toast.show({
                    tone: 'success',
                    title:
                        billing.data?.status === 'trialing'
                            ? m.engines_new_trial_started()
                            : m.engines_new_subscription_started(),
                });
            }
            // Only the ID goes into the URL, so a reload shows the progress again but never the code.
            await navigate({
                to: '/engines/new',
                search: {
                    link: view.linkCodeId,
                    ...(props.search.team === undefined ? {} : { team: props.search.team }),
                },
                replace: true,
            });
        },
    });
    const linkCodeId = issued?.linkCodeId ?? props.search.link;
    const backFromCheckout = props.search.checkout === 'success';
    const eligibility = useQuery({
        ...linkEligibilityQuery(api),
        refetchInterval: (query) =>
            backFromCheckout && query.state.data?.eligibility === 'not-entitled' ? LINK_POLL_MS : false,
        refetchIntervalInBackground: false,
    });
    const eligible = linkCodeId === undefined && eligibility.data?.eligibility === 'allowed';
    const guideUrl = issued?.installGuideUrl ?? eligibility.data?.installGuideUrl;
    // One code per visit, issued without a click once the organization may link (onboarding.md, step 3). The ref
    // survives StrictMode's second effect run, so development does not spend a second code.
    const started = useRef(false);
    const { mutate } = create;
    useEffect(() => {
        if (eligible && !started.current) {
            started.current = true;
            mutate();
        }
    }, [eligible, mutate]);
    const renew = () => {
        mutate();
    };
    const observedLink = useObservedLink(linkCodeId);
    const state = eligibility.data?.eligibility;
    const planStep = linkCodeId === undefined && state === 'not-entitled';
    // Once shown, the plan step stays in the steps for this visit, done.
    const [planShown, setPlanShown] = useState(backFromCheckout);
    if (planStep && !planShown) {
        setPlanShown(true);
    }
    const steps =
        (linkCodeId === undefined && state === undefined) ||
        state === 'engine-limit' ||
        (state === 'not-entitled' && !canChoosePlan(session)) ? null : (
            <LinkSteps
                steps={flowSteps(planShown)}
                current={currentStep(planStep && !backFromCheckout, observedLink)}
            />
        );

    if (linkCodeId !== undefined && props.search.vps) {
        return (
            <Suspense fallback={<Skeleton className="h-16 w-full" />}>
                <VpsProgress link={linkCodeId} provider={props.search.vps} />
            </Suspense>
        );
    }
    if (linkCodeId !== undefined) {
        return (
            <>
                {steps}
                {issued === null ? null : <InstallCommand view={issued} onRenew={renew} renewing={create.isPending} />}
                <LinkProgress
                    key={linkCodeId}
                    linkCodeId={linkCodeId}
                    commandShown={issued !== null}
                    troubleshootingUrl={guideUrl === undefined ? null : troubleshootingLink(guideUrl)}
                    onRenew={renew}
                    renewing={create.isPending}
                />
            </>
        );
    }
    const reason = upgradeReason(create.error);
    const atCodeLimit = problemCode(create.error) === LINK_CODE_LIMIT;
    return (
        <>
            {steps}
            {reason === null ? null : <UpgradeBanner reason={reason} />}
            {atCodeLimit ? <CodeLimitBanner /> : null}
            {state === undefined && eligibility.isError ? (
                <ErrorState
                    message={m.engines_new_eligibility_failed()}
                    onRetry={() => void eligibility.refetch()}
                    retrying={eligibility.isFetching}
                />
            ) : null}
            {state === 'not-entitled' && !backFromCheckout ? <PlanStep checkout={props.search.checkout} /> : null}
            {state === 'engine-limit' ? <UpgradeBanner reason="engine-limit" /> : null}
            {eligible && create.isError && reason === null && !atCodeLimit ? (
                <div>
                    <Button variant="primary" loading={create.isPending} onClick={renew}>
                        {m.engines_new_create()}
                    </Button>
                </div>
            ) : null}
            {state === 'not-entitled' && backFromCheckout ? <CheckoutPending /> : null}
            {(state === undefined && !eligibility.isError) || (eligible && !create.isError) ? (
                <div>
                    <span className="sr-only">{m.loading()}</span>
                    <Skeleton className="h-24 w-full" />
                </div>
            ) : null}
        </>
    );
}

const PENDING_TEAM_KEY = 'ptbk.link.team';

/**
 * The team this link is for. Checkout's return URL knows no team, so the team rides through it in this tab's session
 * storage: a team ID only, which grants nothing. Without storage, the engine gets a team of its own.
 */
function linkSearch(search: NewEngineSearch): NewEngineSearch {
    try {
        if (search.team !== undefined) {
            window.sessionStorage.setItem(PENDING_TEAM_KEY, search.team);
            return search;
        }
        const team = search.checkout === undefined ? null : window.sessionStorage.getItem(PENDING_TEAM_KEY);
        return team !== null && LINK_CODE_ID.test(team) ? { ...search, team } : search;
    } catch {
        return search;
    }
}

export function NewEnginePage(props: { readonly search: NewEngineSearch }) {
    const { billingEnabled } = useSession();
    return <NewEngineContent search={linkSearch(billingEnabled ? props.search : withoutCheckout(props.search))} />;
}

/** With billing off nothing returns from Checkout, so a `checkout` in the address thanks nobody and waits for nothing. */
function withoutCheckout({ link, team, vps }: NewEngineSearch): NewEngineSearch {
    return {
        ...(link === undefined ? {} : { link }),
        ...(team === undefined ? {} : { team }),
        ...(vps === undefined ? {} : { vps }),
    };
}

function NewEngineContent(props: { readonly search: NewEngineSearch }) {
    const session = useSession();
    const canLink = session.activeOrg.permissions.includes(LINK_PERMISSION);
    return (
        // Only a team without an engine is linked here, so the trail leads back to the list, not to an engine.
        <Page
            title={m.engines_new_title()}
            width="narrow"
            breadcrumbs={[
                <Crumb key="engines" to="/engines">
                    {m.nav_teams()}
                </Crumb>,
            ]}
        >
            {canLink && session.licensing ? (
                <Suspense fallback={null}>
                    <LicenseCheckNotice point="engineLink" />
                </Suspense>
            ) : null}
            {canLink ? <LinkFlow search={props.search} /> : <Banner tone="info">{m.engines_new_not_allowed()}</Banner>}
            <TrustLink />
        </Page>
    );
}
