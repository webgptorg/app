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
import { stepUpUrl } from './step-up-url';

interface StepUpContextValue {
    /**
     * Explains that the action needs a fresh passkey check and offers to go to the engine's step-up page. With an
     * intent, the page can put the member back where they were once they return.
     */
    readonly request: (intent?: StepUpIntent) => void;
}

const StepUpContext = createContext<StepUpContextValue | null>(null);

export interface StepUpProviderProps {
    readonly location: BrowserLocation;
    readonly storage: PreferenceStorage | undefined;
    readonly children: ReactNode;
}

/**
 * Sensitive actions (update policy, API tokens, passkeys…) can answer 401 `step-up-required`. The session is fine;
 * the engine's gateway (open code) wants a fresh passkey assertion, so the UI explains that and hands over with a
 * full-page navigation, coming back to the same page afterwards with what the member was doing saved.
 */
export function StepUpProvider({ location, storage, children }: StepUpProviderProps) {
    const [open, setOpen] = useState(false);
    const pending = useRef<StepUpIntent | undefined>(undefined);
    const value = useMemo(
        () => ({
            request: (intent?: StepUpIntent) => {
                pending.current = intent;
                setOpen(true);
            },
        }),
        [],
    );
    const close = () => {
        pending.current = undefined;
        setOpen(false);
    };
    return (
        <StepUpContext value={value}>
            {children}
            <Dialog
                open={open}
                onClose={close}
                size="sm"
                title={m.step_up_title()}
                description={m.step_up_body()}
                footer={
                    <>
                        <Button variant="ghost" onClick={close}>
                            {m.step_up_cancel()}
                        </Button>
                        <Button
                            variant="primary"
                            onClick={() => {
                                if (pending.current !== undefined)
                                    saveStepUpIntent(storage, pending.current, location.pathname, Date.now());
                                location.assign(stepUpUrl(location));
                            }}
                        >
                            {m.step_up_continue()}
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
 * it never performs the action on load.
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
