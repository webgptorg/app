import { BrowserOrigin, BrowserTabId, LiveSessionId, WalletSignInTarget } from '@ptbk/engine-api';
import type { BrowserHelpRequestId, ProblemCode, ReadBrowserSession } from '@ptbk/engine-api';
import { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';

import { unwrap } from '../../app/api-errors';
import type { ApiFailure } from '../../app/api-errors';
import { useBrowser } from '../../app/browser-context';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { browserKeys } from './browser-queries';
import { createWebSocketLiveChannels } from './live-channel';
import { createLiveSession } from './live-session';
import { useLiveSessions } from './live-sessions';

/** Mutations are not cancelled by navigation, so they carry their own timeout instead of a component's signal. */
const MUTATION_TIMEOUT_MS = 30_000;
const signal = () => AbortSignal.timeout(MUTATION_TIMEOUT_MS);
const INVALIDATES = [browserKeys.tabs(), browserKeys.help()] as const;

/** Taking control needs a fresh passkey; these name what reruns by itself on return from a full-page step-up. */
export const CONTROL_TAB_ACTION = 'browser.control-tab';
export const TAKE_CONTROL_ACTION = 'browser.take-control';
export const SIGN_IN_ACTION = 'browser.sign-in';

const PROBLEM_MESSAGES: Partial<Record<ProblemCode, () => string>> = {
    'browser-tab-full': m.browser_error_tab_full,
    'browser-tab-controlled': m.browser_error_tab_controlled,
    'browser-busy': m.browser_error_busy,
    'browser-origin-refused': m.browser_error_origin_refused,
    'browser-session-ended': m.browser_error_session_ended,
    unavailable: m.browser_error_unavailable,
};

function problemMessage(failure: ApiFailure): string {
    const message = failure.kind === 'problem' ? PROBLEM_MESSAGES[failure.problem.code] : undefined;
    return message?.() ?? m.error_mutation_failed();
}

/** Saved input is untrusted: only a well-formed value comes back from storage. */
function parsed<Value>(schema: { safeParse: (value: unknown) => { data?: Value } }, data: unknown, key: string) {
    if (typeof data !== 'object' || data === null) return undefined;
    return schema.safeParse((data as Record<string, unknown>)[key]).data;
}

/** The inputs an automatic rerun after a full-page step-up takes back from storage, or `undefined` to drop it. */
export const RERUN = {
    controlTab: (data: unknown) => {
        const tabId = parsed(BrowserTabId, data, 'tabId');
        return tabId === undefined ? undefined : { tabId };
    },
    takeControl: (data: unknown) => {
        const sessionId = parsed(LiveSessionId, data, 'sessionId');
        return sessionId === undefined ? undefined : { sessionId };
    },
    signIn: (data: unknown) => {
        const origin = parsed(BrowserOrigin, data, 'origin');
        if (origin === undefined || typeof data !== 'object' || data === null) return undefined;
        if (!('wallet' in data)) return { origin };
        const wallet = WalletSignInTarget.safeParse(data.wallet);
        return wallet.success ? { origin, wallet: wallet.data } : undefined;
    },
};

/** Starts the session's channel, makes it the member's current one and opens the viewer. */
export function useShowSession(): (opened: ReadBrowserSession) => void {
    const engineApi = useEngineApi();
    const browser = useBrowser();
    const sessions = useLiveSessions();
    const navigate = useNavigate();
    return useCallback(
        (opened) => {
            const current = sessions.current();
            if (current?.id === opened.id) {
                current.update(opened);
            } else {
                const openChannel = browser.openLiveChannel ?? createWebSocketLiveChannels(browser.location.origin);
                sessions.show(createLiveSession({ engineApi, openChannel }, opened));
            }
            void navigate({ to: '/browser/$sessionId', params: { sessionId: opened.id } });
        },
        [engineApi, browser, sessions, navigate],
    );
}

export function useWatchTab() {
    const engineApi = useEngineApi();
    const show = useShowSession();
    return useStepUpAwareMutation({
        mutationFn: async ({ tabId }: { readonly tabId: BrowserTabId }) =>
            unwrap(await engineApi.browser.watch(tabId, signal())),
        invalidates: INVALIDATES,
        errorMessage: problemMessage,
        onSuccess: show,
    });
}

/** The one click on a help request: control of the tab (step-up), which answers its open help request. */
export function useControlTab() {
    const engineApi = useEngineApi();
    const show = useShowSession();
    return useStepUpAwareMutation({
        mutationFn: async ({ tabId }: { readonly tabId: BrowserTabId }) =>
            unwrap(await engineApi.browser.control(tabId, signal())),
        invalidates: INVALIDATES,
        errorMessage: problemMessage,
        onSuccess: show,
        resumeAs: {
            action: CONTROL_TAB_ACTION,
            data: ({ tabId }) => ({ tabId }),
            rerun: RERUN.controlTab,
        },
    });
}

/** In the viewer: a watching session takes control (step-up); the agent pauses. */
export function useTakeControl() {
    const engineApi = useEngineApi();
    const sessions = useLiveSessions();
    return useStepUpAwareMutation({
        mutationFn: async ({ sessionId }: { readonly sessionId: LiveSessionId }) =>
            unwrap(await engineApi.browser.takeControl(sessionId, signal())),
        invalidates: INVALIDATES,
        errorMessage: problemMessage,
        onSuccess: (session) => {
            sessions.current()?.update(session);
        },
        resumeAs: {
            action: TAKE_CONTROL_ACTION,
            data: ({ sessionId }) => ({ sessionId }),
            rerun: RERUN.takeControl,
        },
    });
}

/** Control goes back to the agent, which resumes; the session keeps watching. A sign-in session ends instead. */
export function useHandBack() {
    const engineApi = useEngineApi();
    const sessions = useLiveSessions();
    return useStepUpAwareMutation({
        mutationFn: async ({ sessionId }: { readonly sessionId: LiveSessionId }) =>
            unwrap(await engineApi.browser.handBack(sessionId, signal())),
        invalidates: INVALIDATES,
        errorMessage: (failure) =>
            failure.kind === 'problem' && failure.problem.code === 'browser-busy'
                ? m.browser_finish_sign_in()
                : problemMessage(failure),
        onSuccess: (session) => {
            sessions.current()?.update(session);
        },
    });
}

export function useDismissHelp() {
    const engineApi = useEngineApi();
    return useStepUpAwareMutation({
        mutationFn: async ({ requestId }: { readonly requestId: BrowserHelpRequestId }) =>
            unwrap(await engineApi.browser.dismissHelpRequest(requestId, signal())),
        invalidates: INVALIDATES,
        errorMessage: problemMessage,
        successMessage: () => m.browser_help_dismissed(),
    });
}

/** A fresh tab at a site the owner signs in to by hand (step-up); `null` when the origin is not one it may take. */
export function signInOrigin(origin: string): string | null {
    return BrowserOrigin.safeParse(origin).success ? origin : null;
}

export function useOpenSignIn() {
    const engineApi = useEngineApi();
    const show = useShowSession();
    return useStepUpAwareMutation({
        mutationFn: async (input: { readonly origin: string; readonly wallet?: WalletSignInTarget }) =>
            unwrap(await engineApi.browser.openSignIn({ browser: null, ...input }, signal())),
        errorMessage: problemMessage,
        onSuccess: show,
        resumeAs: {
            action: SIGN_IN_ACTION,
            data: (input) => ({ ...input }),
            rerun: RERUN.signIn,
        },
    });
}
