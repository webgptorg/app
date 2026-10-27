import { deriveEngineFingerprint } from '@ptbk/protocol';
import { Banner, Button, CodeText, CopyButton, ErrorState, ExternalLink, Skeleton, TrustMark } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleDashed, LoaderCircle, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { m } from '../../../paraglide/messages';
import type { EngineView, LinkCodeStatusView } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { engineQuery, linkCodeQuery, problemCode } from '../../api/queries';
import { useBrowser } from '../../core/browser';
import { ButtonLink } from '../../core/link';
import { EngineOpenLink } from './engine-open-link';
import { shortEngineId } from './engine-labels';

/** onboarding.md, step 4: the page asks every 3 seconds while it is visible, and stops at ready or expiry. */
export const LINK_POLL_MS = 3000;
/** How long row 1 waits before it points to the troubleshooting guide. */
export const WAITING_HINT_MS = 2 * 60_000;
/** How long a linked engine may go without a first heartbeat before the page says so. */
export const NO_HEARTBEAT_HINT_MS = 3 * 60_000;
const TICK_MS = 1000;

/**
 * Where the engine is, from what the dashboard can know (onboarding.md, "What each side can observe"). The order is the
 * checklist's: rows 3 to 5 may arrive in any order, and `owner-pending` covers an engine whose heartbeat counts no
 * member yet.
 */
export type LinkState = 'waiting' | 'expired' | 'linked' | 'owner-pending' | 'ready';

export function linkState(code: LinkCodeStatusView, engine: EngineView | undefined): LinkState {
    switch (code.status) {
        case 'pending':
            return 'waiting';
        case 'expired':
            return 'expired';
        case 'linked':
            break;
    }
    const heartbeat = engine?.heartbeat ?? null;
    if (heartbeat === null) {
        return 'linked';
    }
    return heartbeat.members > 0 ? 'ready' : 'owner-pending';
}

/** The page's clock, ticking only while a hint may still appear. */
function useNow(active: boolean): number {
    const { now } = useBrowser();
    const [current, setCurrent] = useState(now);
    useEffect(() => {
        if (!active) {
            return undefined;
        }
        const timer = setInterval(() => {
            setCurrent(now());
        }, TICK_MS);
        return () => {
            clearInterval(timer);
        };
    }, [active, now]);
    return current;
}

/** When the page first saw `state`; null while it has not. */
function useFirstSeen(state: LinkState, of: LinkState): number | null {
    const { now } = useBrowser();
    const [seen, setSeen] = useState<number | null>(() => (state === of ? now() : null));
    // Adjusting state while rendering, as React documents for state derived from props: no effect, no extra frame.
    if (seen === null && state === of) {
        setSeen(now());
    }
    return seen;
}

type RowState = 'done' | 'current' | 'waiting';

const ROW_ICONS = { done: CircleCheck, current: LoaderCircle, waiting: CircleDashed } as const;

/** Text first; the icon only repeats what the words and the row's position already say (ui.md, Accessibility). */
function Row(props: { readonly step: string; readonly state: RowState; readonly children: ReactNode }) {
    const Icon = ROW_ICONS[props.state];
    return (
        <li data-step={props.step} data-step-state={props.state} className="flex gap-3">
            <Icon
                aria-hidden
                className={`mt-0.5 size-5 shrink-0 ${props.state === 'done' ? 'text-success' : 'text-text-muted'}`}
            />
            <div className="flex min-w-0 flex-col gap-2 text-sm">{props.children}</div>
        </li>
    );
}

function TroubleshootingHint(props: { readonly troubleshootingUrl: string | null }) {
    return (
        <div className="flex flex-col gap-1 text-text-muted">
            <p>{m.link_progress_waiting_hint()}</p>
            {props.troubleshootingUrl === null ? null : (
                <ul className="list-disc ps-5">
                    <li>
                        <ExternalLink href={props.troubleshootingUrl} showHost={false}>
                            {m.link_progress_cause_https()}
                        </ExternalLink>
                    </li>
                    <li>
                        <ExternalLink href={props.troubleshootingUrl} showHost={false}>
                            {m.link_progress_cause_proxy()}
                        </ExternalLink>
                    </li>
                    <li>
                        <ExternalLink href={props.troubleshootingUrl} showHost={false}>
                            {m.link_progress_cause_expired()}
                        </ExternalLink>
                    </li>
                </ul>
            )}
        </div>
    );
}

function LinkedDetails(props: { readonly engineId: string; readonly hostname: string }) {
    const shortId = shortEngineId(props.engineId);
    return (
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
            <dt className="text-text-muted">{m.link_progress_engine_id()}</dt>
            <dd className="flex items-center gap-2">
                <CodeText value={shortId} />
                <CopyFullId engineId={props.engineId} />
            </dd>
            <dt className="text-text-muted">{m.link_progress_address()}</dt>
            <dd className="min-w-0 break-all">
                <CodeText value={props.hostname} />
            </dd>
            <dt className="text-text-muted">{m.engine_fingerprint_title()}</dt>
            <dd className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <TrustMark
                    fingerprint={deriveEngineFingerprint(props.engineId)}
                    state="verified"
                    size="lg"
                    label={m.engines_fingerprint_label({ shortId })}
                />
                <span>{m.link_progress_compare()}</span>
            </dd>
        </dl>
    );
}

function CopyFullId(props: { readonly engineId: string }) {
    return (
        <CopyButton
            value={props.engineId}
            label={m.engines_copy_id({ engineId: shortEngineId(props.engineId) })}
            variant="ghost"
            size="sm"
        />
    );
}

function Reachability(props: { readonly engine: EngineView; readonly troubleshootingUrl: string | null }) {
    const relays = props.engine.reachableRelays;
    if (relays === null) {
        return null;
    }
    if (relays > 0) {
        return (
            <Row step="reachable" state="done">
                <p>{m.engines_reachable({ count: relays })}</p>
            </Row>
        );
    }
    return (
        <Row step="reachable" state="current">
            <p className="inline-flex items-center gap-1">
                <Unplug aria-hidden className="size-4 shrink-0 text-warning" />
                {m.engines_not_reachable()}
            </p>
            {props.troubleshootingUrl === null ? null : (
                <ExternalLink href={props.troubleshootingUrl} showHost={false}>
                    {m.link_progress_proxy_troubleshooting()}
                </ExternalLink>
            )}
        </Row>
    );
}

/** The one sentence the live region speaks, so a screen reader hears each change once and nothing else. */
function announcement(state: LinkState, engine: EngineView | undefined): string {
    switch (state) {
        case 'waiting':
            return m.link_progress_waiting();
        case 'expired':
            return m.engines_new_expired_title();
        case 'linked':
            return m.link_progress_linked();
        case 'owner-pending':
            return m.link_progress_online({ version: engine?.heartbeat?.version ?? '' });
        case 'ready':
            return m.link_progress_ready();
    }
}

function Checklist(props: {
    readonly code: LinkCodeStatusView;
    readonly engine: EngineView | undefined;
    readonly state: LinkState;
    readonly troubleshootingUrl: string | null;
    readonly commandShown: boolean;
}) {
    const { code, engine, state } = props;
    const waitingSince = useFirstSeen(state, 'waiting');
    const linkedSince = useFirstSeen(state, 'linked');
    const now = useNow(state === 'waiting' || state === 'linked');
    const heartbeat = engine?.heartbeat ?? null;
    const linked = code.status === 'linked' ? code : null;
    return (
        <ol className="flex flex-col gap-4">
            <Row step="linked" state={linked === null ? 'current' : 'done'}>
                {linked === null ? (
                    <>
                        <p>{props.commandShown ? m.link_progress_waiting() : m.link_progress_waiting_resumed()}</p>
                        {waitingSince !== null && now - waitingSince >= WAITING_HINT_MS ? (
                            <TroubleshootingHint troubleshootingUrl={props.troubleshootingUrl} />
                        ) : null}
                    </>
                ) : (
                    <>
                        <p className="font-medium">{m.link_progress_linked()}</p>
                        <LinkedDetails engineId={linked.engineId} hostname={linked.hostname} />
                    </>
                )}
            </Row>
            {linked === null ? null : (
                <>
                    <Row step="online" state={heartbeat === null ? 'current' : 'done'}>
                        {heartbeat === null ? (
                            <>
                                <p>{m.link_progress_online_waiting()}</p>
                                {linkedSince !== null && now - linkedSince >= NO_HEARTBEAT_HINT_MS ? (
                                    <p className="text-text-muted">{m.link_progress_no_heartbeat_hint()}</p>
                                ) : null}
                            </>
                        ) : (
                            <p>{m.link_progress_online({ version: heartbeat.version })}</p>
                        )}
                    </Row>
                    {engine === undefined ? null : (
                        <Reachability engine={engine} troubleshootingUrl={props.troubleshootingUrl} />
                    )}
                    <Row
                        step="owner"
                        state={state === 'ready' ? 'done' : state === 'owner-pending' ? 'current' : 'waiting'}
                    >
                        {state === 'ready' ? (
                            <p>{m.link_progress_owner_done()}</p>
                        ) : (
                            <>
                                <p>{m.link_progress_owner()}</p>
                                {state === 'owner-pending' ? (
                                    <p className="text-text-muted">{m.link_progress_owner_delay()}</p>
                                ) : null}
                            </>
                        )}
                    </Row>
                </>
            )}
        </ol>
    );
}

/**
 * Step 4 of onboarding.md: follows one link code from waiting to ready. Everything comes from `/api/*`; nothing is
 * fetched from the engine's hostname (D-06), and the code itself is never asked for again.
 */
export function LinkProgress(props: {
    readonly linkCodeId: string;
    /** The install command is on the page above (it is not after a reload). */
    readonly commandShown: boolean;
    readonly troubleshootingUrl: string | null;
    readonly onRenew: () => void;
    readonly renewing: boolean;
}) {
    const api = useApiClient();
    const code = useQuery({
        ...linkCodeQuery(api, props.linkCodeId),
        refetchInterval: (query) => (query.state.data?.status === 'pending' ? LINK_POLL_MS : false),
        refetchIntervalInBackground: false,
    });
    const linked = code.data?.status === 'linked' ? code.data : null;
    const engine = useQuery({
        ...engineQuery(api, linked?.engineId ?? ''),
        enabled: linked !== null,
        refetchInterval: (query) => ((query.state.data?.heartbeat?.members ?? 0) > 0 ? false : LINK_POLL_MS),
        refetchIntervalInBackground: false,
    });
    if (code.data === undefined) {
        if (problemCode(code.error) === 'not-found') {
            return (
                <Banner tone="warning" title={m.link_progress_unknown_title()}>
                    <p>{m.engines_new_expired_body()}</p>
                    <Button variant="secondary" loading={props.renewing} onClick={props.onRenew}>
                        {m.engines_new_create_again()}
                    </Button>
                </Banner>
            );
        }
        if (code.isError) {
            return (
                <ErrorState
                    message={m.link_progress_load_failed()}
                    onRetry={() => void code.refetch()}
                    retrying={code.isFetching}
                />
            );
        }
        return <Skeleton className="h-16 w-full" />;
    }
    const state = linkState(code.data, engine.data);
    return (
        <section aria-labelledby="link-progress-title" data-link-state={state} className="flex flex-col gap-4">
            <h2 id="link-progress-title" className="font-display text-lg font-semibold">
                {m.link_progress_title()}
            </h2>
            <p className="sr-only" aria-live="polite">
                {announcement(state, engine.data)}
            </p>
            {state === 'expired' ? (
                <Banner tone="warning" title={m.engines_new_expired_title()}>
                    <p>{m.engines_new_expired_body()}</p>
                    <Button variant="secondary" loading={props.renewing} onClick={props.onRenew}>
                        {m.engines_new_create_again()}
                    </Button>
                </Banner>
            ) : (
                <Checklist
                    code={code.data}
                    engine={engine.data}
                    state={state}
                    troubleshootingUrl={props.troubleshootingUrl}
                    commandShown={props.commandShown}
                />
            )}
            {state === 'ready' && linked !== null ? (
                <div className="flex flex-col gap-3" data-link-ready>
                    <p className="font-medium">{m.link_progress_ready()}</p>
                    <div className="flex flex-wrap gap-3">
                        <EngineOpenLink
                            engineId={linked.engineId}
                            hostname={linked.hostname}
                            variant="primary"
                            size="md"
                            prominent
                        />
                        <ButtonLink to="/engines" variant="secondary">
                            {m.link_progress_back()}
                        </ButtonLink>
                    </div>
                </div>
            ) : null}
        </section>
    );
}
