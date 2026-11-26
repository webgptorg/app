import { Button, ExternalLink } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { m } from '../../../paraglide/messages';
import { apiRoutes, type EngineView } from '../../../shared/api/routes';
import { VPS_PROVIDERS, type CloudOffer, type VpsProviderId } from '../../../shared/vps';
import { useApiClient } from '../../api/api-client-context';
import { dataOrThrow, engineQuery } from '../../api/queries';
import { useBrowser } from '../../core/browser';
import { Link } from '../../core/link';
import { useSession } from '../session/use-session';
import { Page } from '../shell/page';
import { EngineOpenLink } from './engine-open-link';
import { LINK_POLL_MS } from './link-progress';
import { linkCodeQuery } from './link-queries';
import { beginVps, clearVps, resumeVps, type VpsTransaction } from './vps-authorization';

export function VpsButtons(props: { readonly offers: readonly CloudOffer[]; readonly link: string }) {
    const { origin, navigate } = useBrowser();
    const api = useApiClient();
    const { activeOrg } = useSession();
    const [error, setError] = useState(false);
    const [busy, setBusy] = useState(false);
    async function start(offer: CloudOffer) {
        setBusy(true);
        try {
            const { clientId } = dataOrThrow(
                await api.call(apiRoutes.authorizeVps, {
                    params: { linkCodeId: props.link },
                    body: { provider: offer.provider },
                }),
            );
            navigate(await beginVps(offer, clientId, activeOrg.id, props.link, origin, window.sessionStorage));
        } catch {
            setError(true);
            setBusy(false);
        }
    }
    return (
        <div className="flex flex-col items-start gap-2">
            {props.offers.map((offer) => (
                <div key={offer.provider} className="flex flex-wrap items-center gap-3">
                    <Button variant="primary" loading={busy} onClick={() => void start(offer)}>
                        {m.vps_start({ provider: VPS_PROVIDERS[offer.provider].label })}
                    </Button>
                    {offer.referralUrl ? (
                        <ExternalLink href={offer.referralUrl}>{m.vps_new_account()}</ExternalLink>
                    ) : null}
                </div>
            ))}
            {error ? <p role="alert">{m.vps_storage()}</p> : null}
        </div>
    );
}

function readyToOpen(engine: EngineView | undefined) {
    return (
        engine !== undefined &&
        ['owner-pending', 'setup-pending', 'online'].includes(engine.status) &&
        engine.reachableRelays !== 0
    );
}

export function VpsProgress({ link, provider }: { readonly link: string; readonly provider: VpsProviderId }) {
    const api = useApiClient();
    const status = useQuery({
        ...linkCodeQuery(api, link),
        refetchInterval: (q) => (q.state.data?.status === 'pending' ? LINK_POLL_MS : false),
    });
    const linked = status.data?.status === 'linked' ? status.data : null;
    const engine = useQuery({
        ...engineQuery(api, linked?.engineId ?? ''),
        enabled: linked !== null,
        refetchInterval: (q) => (readyToOpen(q.state.data) ? false : LINK_POLL_MS),
    });
    const launch = useQuery({
        queryKey: ['vps', link],
        queryFn: async ({ signal }) =>
            dataOrThrow(await api.call(apiRoutes.getVpsLaunch, { params: { linkCodeId: link } }, signal)),
        enabled: status.data?.status === 'pending',
        refetchInterval: (q) => (q.state.data?.reservation?.resourceId === null ? 10_000 : false),
    });
    if (linked && readyToOpen(engine.data))
        return (
            <div>
                <EngineOpenLink
                    hostname={linked.hostname}
                    name={linked.hostname}
                    variant="primary"
                    size="md"
                    wording="engine"
                />
            </div>
        );
    const unavailable = status.data?.status === 'expired' || status.isError || launch.isError;
    if (launch.data?.offer) return <VpsButtons link={link} offers={[launch.data.offer]} />;
    const resource = launch.data?.reservation?.resourceId;
    const consoleUrl = VPS_PROVIDERS[provider].resourcesUrl;
    return (
        <div className="flex flex-col items-start gap-3">
            <p role="status">{unavailable ? m.vps_expired() : m.vps_wait()}</p>
            <ExternalLink href={resource ? consoleUrl + '/' + resource : consoleUrl}>{m.vps_manage()}</ExternalLink>
        </div>
    );
}

export function VpsReturn() {
    const { activeOrg } = useSession();
    return <ConfirmVps key={activeOrg.id} org={activeOrg.id} />;
}

function ConfirmVps({ org }: { readonly org: string }) {
    const api = useApiClient();
    const { navigate } = useBrowser();
    const [attempt] = useState<VpsTransaction | null>(() => {
        try {
            return resumeVps(new URLSearchParams(window.location.search), org, window.sessionStorage);
        } catch {
            return null;
        }
    });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<'declined' | 'unconfirmed' | null>(null);
    const sending = useRef(false);
    useEffect(() => {
        // Replace the OAuth URL after the grant was captured, including on denial or mismatch.
        if (window.location.search) window.history.replaceState(window.history.state, '', window.location.pathname);
    }, []);
    const progress = attempt ? '/engines/new?link=' + attempt.link + '&vps=' + attempt.provider : '/engines/new';
    async function confirm() {
        if (!attempt?.code || sending.current) return;
        sending.current = true;
        setBusy(true);
        try {
            const result = await api.call(apiRoutes.launchVps, {
                params: { linkCodeId: attempt.link },
                body: {
                    provider: attempt.provider,
                    monthlyUsd: VPS_PROVIDERS[attempt.provider].monthlyUsd,
                    code: attempt.code,
                    verifier: attempt.verifier,
                },
            });
            if (result.kind === 'ok') {
                clearVps(window.sessionStorage);
                navigate(progress);
                return;
            }
            setError(result.kind === 'problem' && result.code === 'provider-rejected' ? 'declined' : 'unconfirmed');
        } catch {
            setError('unconfirmed');
        } finally {
            setBusy(false);
            sending.current = false;
        }
    }
    return (
        <Page width="narrow" title={m.vps_title()}>
            {attempt?.code && !error ? (
                <div className="flex flex-col items-start gap-3">
                    <p>{m.vps_plan()}</p>
                    <Button variant="primary" loading={busy} onClick={() => void confirm()}>
                        {m.vps_confirm({ price: VPS_PROVIDERS[attempt.provider].monthlyUsd })}
                    </Button>
                </div>
            ) : (
                <div className="flex flex-col items-start gap-3">
                    <p role="alert">
                        {error === 'declined' ? m.vps_declined() : error ? m.vps_failed() : m.vps_cancelled()}
                    </p>
                    {error === 'declined' && attempt ? (
                        <ExternalLink href={VPS_PROVIDERS[attempt.provider].billingUrl}>{m.vps_billing()}</ExternalLink>
                    ) : null}
                    <Button
                        variant="secondary"
                        onClick={() => {
                            navigate(progress);
                        }}
                    >
                        {m.vps_back()}
                    </Button>
                </div>
            )}
            {attempt?.code && !error ? <Link to="/engines">{m.vps_cancel()}</Link> : null}
        </Page>
    );
}
