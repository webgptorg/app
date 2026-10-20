import { Button, Dialog } from '@ptbk/ui';
import { createContext, use, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { BrowserLocation } from '../../app/sign-in-redirect';
import { m } from '../../paraglide/messages';
import { stepUpUrl } from './step-up-url';

interface StepUpContextValue {
    /** Explains that the action needs a fresh passkey check and offers to go to the engine's step-up page. */
    readonly request: () => void;
}

const StepUpContext = createContext<StepUpContextValue | null>(null);

export interface StepUpProviderProps {
    readonly location: BrowserLocation;
    readonly children: ReactNode;
}

/**
 * Sensitive actions (update policy, API tokens, passkeys…) can answer 401 `step-up-required`. The session is fine;
 * the engine's gateway (open code) wants a fresh passkey assertion, so the UI explains that and hands over with a
 * full-page navigation, coming back to the same page afterwards.
 */
export function StepUpProvider({ location, children }: StepUpProviderProps) {
    const [open, setOpen] = useState(false);
    const value = useMemo(
        () => ({
            request: () => {
                setOpen(true);
            },
        }),
        [],
    );
    return (
        <StepUpContext value={value}>
            {children}
            <Dialog
                open={open}
                onClose={() => {
                    setOpen(false);
                }}
                title={m.step_up_title()}
                description={m.step_up_body()}
                footer={
                    <>
                        <Button
                            onClick={() => {
                                setOpen(false);
                            }}
                        >
                            {m.step_up_cancel()}
                        </Button>
                        <Button
                            variant="primary"
                            onClick={() => {
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
