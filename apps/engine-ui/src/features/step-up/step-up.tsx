import { Button, Dialog } from '@ptbk/ui';
import type { PreferenceStorage } from '@ptbk/ui';
import { useLocation } from '@tanstack/react-router';
import { createContext, use, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { useBrowser } from '../../app/browser-context';
import type { BrowserLocation } from '../../app/sign-in-redirect';
import { m } from '../../paraglide/messages';
import { saveStepUpIntent, takeStepUpIntent } from './step-up-intent';
import type { StepUpIntent } from './step-up-intent';
import { createPopupNonce, stepUpPopupUrl, waitForStepUpPopup } from './step-up-popup';
import type { StepUpPopups } from './step-up-popup';
import { stepUpUrl } from './step-up-url';

export interface StepUpRequest {
    /** Saved for the full-page fallback, so the page can put the member back where they were. */
    readonly intent?: StepUpIntent | undefined;
    /** Runs once the passkey confirmed in the popup: the original action, with its input still in memory. */
    readonly retry?: (() => void) | undefined;
}

interface StepUpContextValue {
    /** Explains that the action needs a fresh passkey check and, on the member's click, asks for it. */
    readonly request: (request?: StepUpRequest) => void;
    /** The input of a fresh intent saved for an automatic rerun of `action` on this page, at most once. */
    readonly takeAutoIntent: (action: string) => unknown;
}

const StepUpContext = createContext<StepUpContextValue | null>(null);

export interface StepUpProviderProps {
    readonly location: BrowserLocation;
    readonly storage: PreferenceStorage | undefined;
    /** Without it, or when the browser blocks the window, the step-up takes the full-page round trip. */
    readonly popups?: StepUpPopups | undefined;
    readonly random?: (bytes: Uint8Array<ArrayBuffer>) => void;
    readonly timeoutMs?: number;
    readonly children: ReactNode;
}

type Phase = 'closed' | 'ask' | 'waiting' | 'not-confirmed';

const cryptoRandom = (bytes: Uint8Array<ArrayBuffer>) => {
    crypto.getRandomValues(bytes);
};

/**
 * Sensitive actions (update policy, API tokens, passkeys…) can answer 401 `step-up-required`. The session is fine;
 * the engine's gateway (open code) wants a fresh passkey assertion. The member's click opens the gateway's step-up page
 * in a small window, and once it answers, the action runs again with what the member entered, secrets included, which
 * never leave memory. If the browser blocks the window, the page hands over with a full-page navigation instead and
 * comes back to the same page with what the member was doing saved.
 */
export function StepUpProvider({
    location,
    storage,
    popups,
    random = cryptoRandom,
    timeoutMs,
    children,
}: StepUpProviderProps) {
    const [phase, setPhase] = useState<Phase>('closed');
    const pending = useRef<StepUpRequest | undefined>(undefined);
    // Each popup gets a number; an answer for an older one (closed, cancelled, unmounted) changes nothing.
    const attempt = useRef(0);
    const value = useMemo(
        () => ({
            request: (request?: StepUpRequest) => {
                pending.current = request;
                setPhase('ask');
            },
            takeAutoIntent: (action: string) =>
                takeStepUpIntent(storage, action, location.pathname, Date.now(), { auto: true }),
        }),
        [storage, location],
    );
    useEffect(
        () => () => {
            attempt.current += 1;
        },
        [],
    );
    const close = () => {
        attempt.current += 1;
        pending.current = undefined;
        setPhase('closed');
    };
    const redirect = () => {
        const intent = pending.current?.intent;
        if (intent !== undefined) saveStepUpIntent(storage, intent, location.pathname, Date.now());
        location.assign(stepUpUrl(location));
    };
    const confirm = () => {
        const nonce = createPopupNonce(random);
        const popup = popups?.open(stepUpPopupUrl(location, nonce)) ?? null;
        if (popup === null || popups === undefined) {
            redirect();
            return;
        }
        attempt.current += 1;
        const current = attempt.current;
        setPhase('waiting');
        void waitForStepUpPopup(popups, popup, nonce, timeoutMs).then((outcome) => {
            if (current !== attempt.current) return;
            if (outcome !== 'confirmed') {
                setPhase('not-confirmed');
                return;
            }
            const retry = pending.current?.retry;
            pending.current = undefined;
            setPhase('closed');
            retry?.();
        });
    };
    let description = m.step_up_body();
    if (phase === 'waiting') description = m.step_up_waiting();
    else if (phase === 'not-confirmed') description = m.step_up_not_confirmed();
    return (
        <StepUpContext value={value}>
            {children}
            <Dialog
                open={phase !== 'closed'}
                onClose={close}
                size="sm"
                title={m.step_up_title()}
                description={description}
                footer={
                    <>
                        <Button variant="ghost" onClick={close}>
                            {m.step_up_cancel()}
                        </Button>
                        <Button variant="primary" loading={phase === 'waiting'} onClick={confirm}>
                            {phase === 'not-confirmed' ? m.step_up_try_again() : m.step_up_continue()}
                        </Button>
                    </>
                }
            >
                {null}
            </Dialog>
        </StepUpContext>
    );
}

export function useStepUp(): StepUpContextValue {
    const value = use(StepUpContext);
    if (value === null) throw new Error('useStepUp() needs a <StepUpProvider> above it');
    return value;
}

/**
 * What the member was doing on this page before the step-up round trip, parsed by `parse` (stored data is untrusted
 * input), or `undefined`. Read after mount, so the page restores its form or reopens its dialog for one more click;
 * it never performs the action on load. Intents saved for an automatic rerun are left to `useAutoRetriedStepUp`.
 */
export function useResumedStepUp<Data>(action: string, parse: (data: unknown) => Data | undefined): Data | undefined {
    const { storage } = useBrowser();
    const pathname = useLocation({ select: (location) => location.pathname });
    const [resumed, setResumed] = useState<Data | undefined>(undefined);
    const parseRef = useRef(parse);
    useEffect(() => {
        const data = takeStepUpIntent(storage, action, pathname, Date.now());
        const parsed = data === undefined ? undefined : parseRef.current(data);
        if (parsed !== undefined) setResumed(parsed);
    }, [storage, action, pathname]);
    return resumed;
}

/**
 * Back from the full-page step-up with an intent saved for an automatic rerun: `run` gets its parsed input once, if it
 * is fresh and for this page. The member clicked for exactly this action moments ago, and the input holds no secret.
 */
export function useAutoRetriedStepUp<Data>(
    action: string | undefined,
    parse: ((data: unknown) => Data | undefined) | undefined,
    run: (data: Data) => void,
): void {
    const { takeAutoIntent } = useStepUp();
    const latest = useRef({ parse, run });
    useEffect(() => {
        latest.current = { parse, run };
    });
    useEffect(() => {
        if (action === undefined) return;
        const data = takeAutoIntent(action);
        const parsed = data === undefined ? undefined : latest.current.parse?.(data);
        if (parsed !== undefined) latest.current.run(parsed);
    }, [takeAutoIntent, action]);
}
