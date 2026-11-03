import { Banner, Button, Card, CopyButton, ErrorState, ExternalLink, Skeleton, Tabs, useToast } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import { m } from '../../../paraglide/messages';
import { apiRoutes, type LinkCodeView } from '../../../shared/api/routes';
import type { InstallPathLabelKey } from '../../../shared/install-paths';
import { useApiClient } from '../../api/api-client-context';
import { billingQuery, dataOrThrow, problemCode } from '../../api/queries';
import { useBrowser } from '../../core/browser';
import { Link } from '../../core/link';
import { useAppMutation } from '../../core/mutations';
import { PlanOfferList } from '../billing/plan-offers';
import { useSession } from '../session/use-session';
import { TrustLink } from '../trust/trust-link';
import { LINK_POLL_MS, LinkProgress, useObservedLinkState } from './link-progress';
import type { LinkState } from './link-progress';
import { linkCodeQuery, linkEligibilityQuery } from './link-queries';
import { LinkSteps } from './link-steps';
import type { LinkStep } from './link-steps';

const LINK_PERMISSION = 'engine.link';
const BILLING_PERMISSION = 'billing.manage';
const SECOND_MS = 1000;
const MOVING_ANCHOR = 'moving-an-existing-deployment';
const TROUBLESHOOTING_ANCHOR = 'troubleshooting';

const INSTALL_PATH_LABELS: Record<InstallPathLabelKey, () => string> = {
    'docker-server': () => m.engines_new_tab_docker_server(),
    'docker-compose': () => m.engines_new_tab_docker_compose(),
    'already-running': () => m.engines_new_tab_already_running(),
};

type InstallCommandView = LinkCodeView['installCommands'][number];

export type CheckoutReturn = 'success' | 'cancel';

export interface NewEngineSearch {
    /** A link code's ID (not the code): the page shows that code's progress, after a reload too. */
    readonly link?: string;
    readonly checkout?: CheckoutReturn;
    /** The team the new engine joins (ADR 0018); without it the engine gets a team of its own. */
    readonly team?: string;
}

const LINK_CODE_ID = /^[a-z2-7]{26}$/;

/** `link` is a link code's ID from issuance; `checkout` is set by the Checkout return URLs. Anything else is dropped. */
export function parseNewEngineSearch(search: Readonly<Record<string, unknown>>): NewEngineSearch {
    const { link, checkout, team } = search;
    return {
        ...(typeof link === 'string' && LINK_CODE_ID.test(link) ? { link } : {}),
        ...(typeof team === 'string' && LINK_CODE_ID.test(team) ? { team } : {}),
        ...(checkout === 'success' || checkout === 'cancel' ? { checkout } : {}),
    };
}

type UpgradeReason = 'not-entitled' | 'engine-limit';

function upgradeReason(error: unknown): UpgradeReason | null {
    const code = problemCode(error);
    return code === 'not-entitled' || code === 'engine-limit' ? code : null;
}

function linkCodeErrorMessage(error: unknown): string | undefined {
    switch (upgradeReason(error)) {
        case 'not-entitled':
            return m.engines_new_not_entitled_title();
        case 'engine-limit':
            return m.engines_new_engine_limit_title();
        case null:
            return undefined;
    }
}

/** Ticks every second from the injected clock; the caller remounts it per code (`key`). */
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

function minutesAndSeconds(ms: number): string {
    const seconds = Math.ceil(ms / SECOND_MS);
    return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

function UpgradeBanner(props: { readonly reason: UpgradeReason }) {
    const title =
        props.reason === 'not-entitled' ? m.engines_new_not_entitled_title() : m.engines_new_engine_limit_title();
    return (
        <Banner tone="warning" title={title}>
            <p>
                {props.reason === 'not-entitled'
                    ? m.engines_new_not_entitled_body()
                    : m.engines_new_engine_limit_body()}
            </p>
            <Link to="/billing">{m.engines_new_upgrade()}</Link>
        </Banner>
    );
}

function guideLink(guideUrl: string, anchor: string): string {
    return `${guideUrl}#${anchor}`;
}

/** Text only: a command is never parsed as markup, and the copy is the exact configured string. */
function InstallPathPanel(props: { readonly path: InstallCommandView; readonly guideUrl: string }) {
    const { path, guideUrl } = props;
    return (
        <div className="flex flex-col gap-3">
            {path.id === 'compose' ? <p className="text-sm">{m.engines_new_compose_hint()}</p> : null}
            <div className="overflow-hidden rounded-control bg-(--code-text-bg) text-(--code-text-text)">
                <div className="flex justify-end px-2 pt-2">
                    <CopyButton value={path.command} label={m.engines_new_copy()} variant="secondary" showLabel />
                </div>
                <pre className="px-3 pt-1 pb-3 font-mono text-sm wrap-anywhere whitespace-pre-wrap">
                    <code>{path.command}</code>
                </pre>
            </div>
            <p className="text-sm text-text-muted">
                {m.engines_new_requirements()}{' '}
                <ExternalLink href={guideLink(guideUrl, path.docsAnchor)}>{m.engines_new_docs()}</ExternalLink>
            </p>
            {path.id === 'connect' ? (
                <p className="text-sm">
                    {m.engines_new_move()}{' '}
                    <ExternalLink href={guideLink(guideUrl, MOVING_ANCHOR)}>{m.engines_new_move_docs()}</ExternalLink>
                </p>
            ) : null}
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
    const remaining = useRemainingMs(props.view.expiresAt);
    const paths = props.view.installCommands;
    const [selectedId, setSelectedId] = useState<string>(paths[0]?.id ?? '');
    // Only observes what the progress panel polls; it never asks on its own.
    const status = useQuery({ ...linkCodeQuery(api, props.view.linkCodeId), enabled: false }).data?.status;
    if (status === 'linked') {
        return null;
    }
    if (remaining === 0 || status === 'expired') {
        return <ExpiredBanner onRenew={props.onRenew} renewing={props.renewing} />;
    }
    return (
        <Card title={m.engines_new_command_title()}>
            <div className="flex flex-col gap-3">
                <p className="text-sm">{m.engines_new_intro()}</p>
                <Tabs
                    label={m.engines_new_tabs_label()}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    tabs={paths.map((path) => ({
                        id: path.id,
                        label: INSTALL_PATH_LABELS[path.labelKey](),
                        // Keyed, so "Copied" on one command never shows on the next tab's.
                        panel: <InstallPathPanel key={path.id} path={path} guideUrl={props.view.installGuideUrl} />,
                    }))}
                />
                <p className="text-sm text-text-muted" aria-live="off">
                    {m.engines_new_command_body({ time: minutesAndSeconds(remaining) })}
                </p>
            </div>
        </Card>
    );
}

/** Step 2 of onboarding.md: without `engines.create`, the plans come first, and Checkout returns here. */
function PlanStep(props: { readonly checkout: CheckoutReturn | undefined }) {
    const api = useApiClient();
    const session = useSession();
    const billing = useQuery(billingQuery(api));
    if (!session.activeOrg.permissions.includes(BILLING_PERMISSION)) {
        return <UpgradeBanner reason="not-entitled" />;
    }
    return (
        <Card title={m.engines_new_plan_title()}>
            {props.checkout === 'cancel' ? <Banner tone="info">{m.billing_checkout_cancel()}</Banner> : null}
            <p className="text-sm text-text-muted">{m.engines_new_plan_body()}</p>
            {billing.data === undefined ? (
                billing.isError ? (
                    <ErrorState
                        message={m.billing_load_failed()}
                        onRetry={() => void billing.refetch()}
                        retrying={billing.isFetching}
                    />
                ) : (
                    <Skeleton className="h-32 w-full" />
                )
            ) : (
                <PlanOfferList
                    plans={billing.data.plans}
                    trialAvailable={billing.data.trialAvailable}
                    returnTo="engines-new"
                />
            )}
        </Card>
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

function currentStep(planStep: boolean, link: LinkState | undefined): LinkStep | null {
    if (planStep) {
        return 'plan';
    }
    switch (link) {
        case undefined:
        case 'waiting':
        case 'expired':
            return 'install';
        case 'linked':
            return 'connect';
        case 'owner-pending':
            return 'finish';
        case 'ready':
            return null;
    }
}

function LinkFlow(props: { readonly search: NewEngineSearch }) {
    const api = useApiClient();
    const session = useSession();
    const navigate = useNavigate();
    const toast = useToast();
    // Only to say "trial" or "subscription" in the thanks after Checkout.
    const billing = useQuery({ ...billingQuery(api), enabled: props.search.checkout === 'success' });
    const [issued, setIssued] = useState<LinkCodeView | null>(null);
    const create = useAppMutation<LinkCodeView>({
        mutationFn: async () =>
            props.search.team === undefined
                ? dataOrThrow(await api.call(apiRoutes.createLinkCode, {}))
                : dataOrThrow(await api.call(apiRoutes.createTeamLinkCode, { params: { teamId: props.search.team } })),
        errorMessage: linkCodeErrorMessage,
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
    const linkState = useObservedLinkState(linkCodeId);
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
        (state === 'not-entitled' && !session.activeOrg.permissions.includes(BILLING_PERMISSION)) ? null : (
            <LinkSteps steps={flowSteps(planShown)} current={currentStep(planStep && !backFromCheckout, linkState)} />
        );

    if (linkCodeId !== undefined) {
        return (
            <>
                {steps}
                {issued === null ? null : <InstallCommand view={issued} onRenew={renew} renewing={create.isPending} />}
                <LinkProgress
                    key={linkCodeId}
                    linkCodeId={linkCodeId}
                    commandShown={issued !== null}
                    troubleshootingUrl={guideUrl === undefined ? null : guideLink(guideUrl, TROUBLESHOOTING_ANCHOR)}
                    onRenew={renew}
                    renewing={create.isPending}
                />
            </>
        );
    }
    const reason = upgradeReason(create.error);
    return (
        <>
            {steps}
            {reason === null ? null : <UpgradeBanner reason={reason} />}
            {state === undefined && eligibility.isError ? (
                <ErrorState
                    message={m.engines_new_eligibility_failed()}
                    onRetry={() => void eligibility.refetch()}
                    retrying={eligibility.isFetching}
                />
            ) : null}
            {state === 'not-entitled' && !backFromCheckout ? <PlanStep checkout={props.search.checkout} /> : null}
            {state === 'engine-limit' ? <UpgradeBanner reason="engine-limit" /> : null}
            {eligible && create.isError && reason === null ? (
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
    return <NewEngineContent search={linkSearch(props.search)} />;
}

function NewEngineContent(props: { readonly search: NewEngineSearch }) {
    const session = useSession();
    const canLink = session.activeOrg.permissions.includes(LINK_PERMISSION);
    return (
        <div className="flex flex-col gap-6">
            {/* Only a team without an engine is linked here, so there is no engine to go back to yet. */}
            <Link to="/engines" variant="standalone" className="inline-flex items-center gap-1 self-start text-sm">
                <ArrowLeft aria-hidden className="size-4" />
                {m.engine_back()}
            </Link>
            <h1 className="font-display text-2xl font-semibold">{m.engines_new_title()}</h1>
            {canLink ? <LinkFlow search={props.search} /> : <Banner tone="info">{m.engines_new_not_allowed()}</Banner>}
            <TrustLink />
        </div>
    );
}
