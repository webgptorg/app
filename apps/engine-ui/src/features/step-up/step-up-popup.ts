import { STEP_UP_PATH } from '@ptbk/engine-api';

import type { BrowserLocation } from '../../app/sign-in-redirect';
import { safeNextPath } from '../../security/safe-url';

/** The gateway's step-up page posts here when it ran as a popup (`@ptbk/gateway-pages`). */
export const STEP_UP_CHANNEL = 'ptbk-step-up';
/** Long enough for a passkey prompt on a phone nearby; the window is closed after it. */
export const STEP_UP_POPUP_TIMEOUT_MS = 3 * 60_000;
const CLOSED_POLL_MS = 500;
const POPUP_FEATURES = 'popup,width=480,height=640';

/** The one window the step-up runs in, as far as the page needs it. */
export interface StepUpPopup {
    readonly closed: boolean;
    close(): void;
}

/** Popups for the step-up, injected so tests can stand in for the browser's window and channel. */
export interface StepUpPopups {
    /** `null` when the browser blocked the window. */
    open(url: string): StepUpPopup | null;
    /** Calls `onMessage` with every answer a step-up popup of this origin posts; returns the unsubscribe. */
    listen(onMessage: (data: unknown) => void): () => void;
}

export type StepUpPopupOutcome = 'confirmed' | 'closed' | 'timeout';

/** A fresh token per popup: the page answers with it, so an answer from an older or another tab's popup is ignored. */
export function createPopupNonce(random: (bytes: Uint8Array<ArrayBuffer>) => void): string {
    const bytes = new Uint8Array(18);
    random(bytes);
    return btoa(String.fromCharCode(...bytes))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '');
}

export function stepUpPopupUrl(location: Omit<BrowserLocation, 'assign'>, nonce: string): string {
    const returnTo = safeNextPath(`${location.pathname}${location.search}${location.hash}`, location.origin) ?? '/';
    return `${STEP_UP_PATH}?${new URLSearchParams({ mode: 'popup', nonce, returnTo }).toString()}`;
}

function isConfirmation(data: unknown, nonce: string): boolean {
    if (typeof data !== 'object' || data === null) return false;
    const record = data as Record<string, unknown>;
    return record['type'] === 'step-up-confirmed' && record['nonce'] === nonce;
}

/**
 * Waits for the popup to answer: confirmed with this nonce, closed without an answer, or timed out (the window is
 * then closed). Anything else on the channel is ignored.
 */
export function waitForStepUpPopup(
    popups: StepUpPopups,
    popup: StepUpPopup,
    nonce: string,
    timeoutMs: number = STEP_UP_POPUP_TIMEOUT_MS,
): Promise<StepUpPopupOutcome> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (outcome: StepUpPopupOutcome) => {
            if (settled) return;
            settled = true;
            stop();
            clearInterval(poll);
            clearTimeout(deadline);
            if (outcome === 'timeout') popup.close();
            resolve(outcome);
        };
        const stop = popups.listen((data) => {
            if (isConfirmation(data, nonce)) finish('confirmed');
        });
        // The answer is posted before the window closes itself, but may be delivered after `closed` turns true, so a
        // close only counts once a poll later still has no answer.
        let seenClosed = false;
        const poll = setInterval(() => {
            if (!popup.closed) return;
            if (seenClosed) finish('closed');
            seenClosed = true;
        }, CLOSED_POLL_MS);
        const deadline = setTimeout(() => {
            finish('timeout');
        }, timeoutMs);
    });
}

/** The browser's own: `window.open` and the gateway's channel, plus `postMessage` from the popup checked by origin. */
export function createWindowStepUpPopups(scope: Window & typeof globalThis): StepUpPopups {
    return {
        open: (url) => scope.open(url, 'ptbk-step-up', POPUP_FEATURES),
        listen: (onMessage) => {
            const channel =
                typeof scope.BroadcastChannel === 'function' ? new scope.BroadcastChannel(STEP_UP_CHANNEL) : null;
            const fromChannel = (event: MessageEvent) => {
                onMessage(event.data);
            };
            const fromWindow = (event: MessageEvent) => {
                if (event.origin === scope.location.origin) onMessage(event.data);
            };
            channel?.addEventListener('message', fromChannel);
            scope.addEventListener('message', fromWindow);
            return () => {
                channel?.close();
                scope.removeEventListener('message', fromWindow);
            };
        },
    };
}
