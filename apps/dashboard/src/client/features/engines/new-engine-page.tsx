import { Banner, Button, Card, CopyButton, ErrorState, ExternalLink, Skeleton, Tabs } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
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
import { LINK_POLL_MS, LinkProgress } from './link-progress';
import { linkCodeQuery, linkEligibilityQuery } from './link-queries';

const LINK_PERMISSION = 'engine.link';
const BILLING_PERMISSION = 'billing.manage';
const SECOND_MS = 1000;
const MINUTE_S = 60;
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
}

const LINK_CODE_ID = /^[a-z2-7]{26}$/;

/** `link` is a link code's ID from issuance; `checkout` is set by the Checkout return URLs. Anything else is dropped. */
export function parseNewEngineSearch(search: Readonly<Record<string, unknown>>): NewEngineSearch {
    const { link, checkout } = search;
    return {
        ...(typeof link === 'string' && LINK_CODE_ID.test(link) ? { link } : {}),
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

/** "30 minutes", or "30 seconds" for the short lifetimes the e2e stack configures. */
function lifetimeText(seconds: number): string {
    return seconds % MINUTE_S === 0
        ? m.engines_new_lifetime_minutes({ count: seconds / MINUTE_S })
        : m.engines_new_lifetime_seconds({ count: seconds });
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
            <div className="flex items-start gap-1">
                <pre className="min-w-0 flex-1 rounded-control bg-(--code-text-bg) p-3 font-mono text-sm wrap-anywhere whitespace-pre-wrap text-(--code-text-text)">
                    <code>{path.command}</code>
                </pre>
                <CopyButton value={path.command} label={m.engines_new_copy()} />
            </div>
            <p className="text-sm">
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
                <p className="text-sm">{m.engines_new_command_body()}</p>
                <Tabs
                    label={m.engines_new_tabs_label()}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    tabs={paths.map((path) => ({
                        id: path.id,
                        label: INSTALL_PATH_LABELS[path.labelKey](),
                        panel: <InstallPathPanel path={path} guideUrl={props.view.installGuideUrl} />,
                    }))}
                />
                <p className="text-sm text-text-muted" aria-live="off">
                    {m.engines_new_expires_in({ time: minutesAndSeconds(remaining) })}
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
function CheckoutThanks(props: { readonly entitled: boolean }) {
    const api = useApiClient();
    const billing = useQuery(billingQuery(api));
    const trial = billing.data?.status === 'trialing';
    return (
        <Banner tone="success" title={trial ? m.engines_new_trial_started() : m.billing_checkout_success_title()}>
            {props.entitled ? null : m.billing_checkout_success_body()}
        </Banner>
    );
}

function LinkFlow(props: { readonly search: NewEngineSearch }) {
    const api = useApiClient();
    const navigate = useNavigate();
    const [issued, setIssued] = useState<LinkCodeView | null>(null);
    const create = useAppMutation<LinkCodeView>({
        mutationFn: async () => dataOrThrow(await api.call(apiRoutes.createLinkCode, {})),
        errorMessage: linkCodeErrorMessage,
        onSuccess: async (view) => {
            setIssued(view);
            // Only the ID goes into the URL, so a reload shows the progress again but never the code.
            await navigate({
                to: '/engines/new',
                search: {
                    link: view.linkCodeId,
                    ...(props.search.checkout === 'success' ? { checkout: 'success' } : {}),
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

    if (linkCodeId !== undefined) {
        return (
            <>
                {backFromCheckout ? <CheckoutThanks entitled /> : null}
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
    const state = eligibility.data?.eligibility;
    return (
        <>
            {backFromCheckout ? <CheckoutThanks entitled={state === 'allowed'} /> : null}
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
            {(state === undefined && !eligibility.isError) ||
            (eligible && !create.isError) ||
            (state === 'not-entitled' && backFromCheckout) ? (
                <div>
                    <span className="sr-only">{m.loading()}</span>
                    <Skeleton className="h-24 w-full" />
                </div>
            ) : null}
        </>
    );
}

export function NewEnginePage(props: { readonly search: NewEngineSearch }) {
    const api = useApiClient();
    const session = useSession();
    const canLink = session.activeOrg.permissions.includes(LINK_PERMISSION);
    const lifetimeS = useQuery({ ...linkEligibilityQuery(api), enabled: false }).data?.linkCodeTtlS;
    return (
        <div className="flex flex-col gap-6">
            <h1 className="font-display text-2xl font-semibold">{m.engines_new_title()}</h1>
            <p>
                {lifetimeS === undefined
                    ? m.engines_new_intro_short()
                    : m.engines_new_intro({ lifetime: lifetimeText(lifetimeS) })}
            </p>
            {canLink ? <LinkFlow search={props.search} /> : <Banner tone="info">{m.engines_new_not_allowed()}</Banner>}
        </div>
    );
}
