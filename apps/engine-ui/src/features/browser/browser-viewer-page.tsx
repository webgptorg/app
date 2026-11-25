import { KNOWN_CAPABILITIES, LiveSessionId } from '@ptbk/engine-api';
import type { ChatId, ReadBrowserTab, RunId } from '@ptbk/engine-api';
import { ActionMenu, Button, EmptyState, Skeleton, StatusPill } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { MonitorX, X } from 'lucide-react';
import { useEffect, useId, useMemo } from 'react';

import { unwrap } from '../../app/api-errors';
import { useBrowser } from '../../app/browser-context';
import { useEngineApi } from '../../app/engine-api-context';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { chatName } from '../chat/chat-name';
import { chatQueryOptions } from '../chat/chat-queries';
import { EntityChip } from '../entities/entity-chip';
import { runTitle } from '../runs/run-format';
import { RunStatusPill } from '../runs/run-status';
import { runQueryOptions } from '../runs/runs-queries';
import { Page } from '../shell/page';
import { siteName } from '../wallet/wallet-origin';
import { browserKeys, CONTROL_REQUIREMENT, useBrowserTab } from './browser-queries';
import { viewState, whereLabel } from './browser-labels';
import { ComputerControlLink } from './computer-control-link';
import { createWebSocketLiveChannels } from './live-channel';
import { createLiveSession } from './live-session';
import type { LiveSession, LiveView } from './live-session';
import { LiveScreen } from './live-screen';
import { useCurrentLiveSession, useLiveSessions } from './live-sessions';
import { useHandBack, useTakeControl, useWatchTab } from './use-browser-actions';
import { useAgentName } from './use-agent-name';
import { useLiveView } from './use-live-view';

const route = getRouteApi('/browser/$sessionId');

/** The member's current session when it is this one; otherwise this one read from the engine, e.g. after a reload. */
function useViewerSession(sessionId: LiveSessionId | undefined): LiveSession | null | 'missing' {
    const engineApi = useEngineApi();
    const browser = useBrowser();
    const sessions = useLiveSessions();
    const current = useCurrentLiveSession();
    const shown = current !== null && current.id === sessionId ? current : null;
    const lookup = useQuery({
        queryKey: [...browserKeys.all, 'session', sessionId],
        queryFn: async ({ signal }) => unwrap(await engineApi.browser.getSession(sessionId as LiveSessionId, signal)),
        enabled: sessionId !== undefined && shown === null,
        // Read once to reattach; from then on the session's own channel and calls keep it current.
        staleTime: Infinity,
        gcTime: 0,
        retry: false,
    });
    const found = lookup.data?.id === sessionId ? lookup.data : undefined;
    const deps = useMemo(
        () => ({
            engineApi,
            openChannel: browser.openLiveChannel ?? createWebSocketLiveChannels(browser.location.origin),
        }),
        [engineApi, browser],
    );
    // Only a live session becomes the member's current one; an ended one is shown here and replaces nothing.
    const ended = useMemo(
        () => (found?.status === 'open' || found === undefined ? null : createLiveSession(deps, found)),
        [found, deps],
    );
    useEffect(() => {
        if (shown === null && found?.status === 'open') sessions.show(createLiveSession(deps, found), { end: false });
    }, [shown, found, sessions, deps]);
    if (shown !== null) return shown;
    if (ended !== null) return ended;
    return sessionId === undefined || lookup.isError ? 'missing' : null;
}

function LinkedRun({ runId }: { readonly runId: RunId }) {
    const allowed = useAllows({ capability: KNOWN_CAPABILITIES.runs, permission: 'runs.read' });
    const run = useQuery({ ...runQueryOptions(useEngineApi(), runId), enabled: allowed });
    if (run.data === undefined) return null;
    const now = run.data.progress?.now?.trim() ?? '';
    return (
        <>
            <span className="flex flex-wrap items-center gap-1.5">
                <EntityChip kind="run" id={runId} name={runTitle(run.data)} />
                <RunStatusPill status={run.data.status} />
            </span>
            {/* The agent's own words: text only. */}
            {now === '' ? null : (
                <p className="line-clamp-3 [overflow-wrap:anywhere] text-text-muted">
                    {m.browser_run_now({ step: now })}
                </p>
            )}
        </>
    );
}

function LinkedChat({ chatId }: { readonly chatId: ChatId }) {
    const allowed = useAllows({ permission: 'chats.read' });
    const chat = useQuery({ ...chatQueryOptions(useEngineApi(), chatId), enabled: allowed });
    return (
        <EntityChip kind="chat" id={chatId} name={chat.data === undefined ? m.browser_chat() : chatName(chat.data)} />
    );
}

/**
 * Narration from what already exists (ADR 0019): the agent, the chat and the run the tab belongs to, with the run's
 * own progress line, all kept current by their event streams. A narration channel of its own would slot in here.
 */
function LinkedWork({ tab, agentName }: { readonly tab: ReadBrowserTab; readonly agentName: string | null }) {
    if (tab.agentId === null && tab.chatId === null && tab.runId === null) return null;
    return (
        <div className="flex flex-col gap-2">
            <h2 className="text-xs font-medium text-text-muted">{m.browser_working_on()}</h2>
            <span className="flex flex-wrap items-center gap-1.5">
                {tab.agentId === null ? null : (
                    <EntityChip kind="agent" id={tab.agentId} name={agentName ?? tab.agentId} />
                )}
                {tab.chatId === null ? null : <LinkedChat chatId={tab.chatId} />}
            </span>
            {tab.runId === null ? null : <LinkedRun runId={tab.runId} />}
        </div>
    );
}

function ViewerActions({ session, view }: { readonly session: LiveSession; readonly view: LiveView }) {
    const canControl = useAllows(CONTROL_REQUIREMENT);
    const takeControl = useTakeControl();
    const handBack = useHandBack();
    if (view.endReason !== null) return null;
    const signIn = view.session.kind === 'sign-in';
    const controlling = view.mode === 'controlling';
    let primary = null;
    if (controlling) {
        primary = (
            <Button
                variant="primary"
                loading={handBack.isPending}
                onClick={() => {
                    handBack.mutate({ sessionId: session.id });
                }}
            >
                {signIn ? m.browser_done_sign_in() : m.browser_hand_back()}
            </Button>
        );
    } else if (canControl && view.agent !== 'paused' && view.connection === 'open') {
        primary = (
            <Button
                variant="primary"
                loading={takeControl.isPending}
                onClick={() => {
                    takeControl.mutate({ sessionId: session.id });
                }}
            >
                {m.browser_take_control()}
            </Button>
        );
    }
    return (
        <div className="flex items-center gap-2">
            {primary}
            {signIn ? <ComputerControlLink /> : null}
            <ActionMenu
                label={m.browser_more_actions()}
                items={[
                    {
                        kind: 'item',
                        id: 'end',
                        label: controlling ? m.browser_end() : m.browser_stop_watching(),
                        icon: <X />,
                        tone: 'danger',
                        onSelect: () => {
                            void session.end();
                        },
                    },
                ]}
            />
        </div>
    );
}

function Viewer({ session }: { readonly session: LiveSession }) {
    const view = useLiveView(session);
    const tab = useBrowserTab(session.tabId);
    const agentName = useAgentName(tab?.agentId ?? null);
    const watchAgain = useWatchTab();
    const hintId = useId();
    const state = viewState(view);
    const signIn = view.session.kind === 'sign-in';
    const site = view.origin === null ? m.browser_hidden_site() : siteName(view.origin);
    let title = m.browser_title_generic();
    if (signIn) title = m.browser_title_sign_in({ site });
    else if (agentName !== null) title = m.browser_title_agent({ agent: agentName });
    const ended = view.endReason !== null;
    return (
        <Page
            title={title}
            description={
                <span className="flex flex-wrap items-center gap-2" role="status">
                    <StatusPill tone={state.tone}>{state.label}</StatusPill>
                    {ended || signIn ? null : (
                        <span className="[overflow-wrap:anywhere]">{whereLabel(view.origin)}</span>
                    )}
                </span>
            }
            actions={<ViewerActions session={session} view={view} />}
        >
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
                <div className="flex min-w-0 flex-col gap-2">
                    <LiveScreen
                        session={session}
                        view={view}
                        hintId={hintId}
                        label={
                            view.origin === null
                                ? m.browser_canvas_label_hidden()
                                : m.browser_canvas_label({ where: whereLabel(view.origin) })
                        }
                        endAction={
                            signIn ? null : (
                                <Button
                                    loading={watchAgain.isPending}
                                    onClick={() => {
                                        watchAgain.mutate({ tabId: session.tabId });
                                    }}
                                >
                                    {m.browser_watch_again()}
                                </Button>
                            )
                        }
                    />
                    <p id={hintId} className="text-sm text-text-muted">
                        {ended || view.blocked !== null
                            ? null
                            : view.mode === 'controlling'
                              ? m.browser_hint_controlling()
                              : m.browser_hint_watching()}
                    </p>
                </div>
                <aside className="flex flex-col gap-4 text-sm">
                    {tab === undefined ? null : <LinkedWork tab={tab} agentName={agentName} />}
                    {view.others > 0 && !ended ? (
                        <p className="text-text-muted">{m.browser_others({ count: view.others })}</p>
                    ) : null}
                    <p className="text-xs text-text-muted">{m.browser_trust()}</p>
                </aside>
            </div>
        </Page>
    );
}

/** `/browser/$sessionId`: one live session on one tab, the member's own. Loads lazily with the route. */
export function BrowserViewerPage() {
    const sessionId = LiveSessionId.safeParse(route.useParams({ select: (params) => params.sessionId })).data;
    const session = useViewerSession(sessionId);
    if (session === 'missing') {
        return (
            <Page title={m.browser_title_generic()}>
                <EmptyState icon={<MonitorX aria-hidden />} title={m.browser_not_found()} />
            </Page>
        );
    }
    if (session === null) {
        return (
            <Page title={m.browser_title_generic()}>
                <Skeleton shape="block" className="aspect-[16/10] w-full" />
            </Page>
        );
    }
    return <Viewer key={session.id} session={session} />;
}
