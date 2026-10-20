import { Banner, Button, Dialog } from '@ptbk/ui';
import { createContext, use, useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { m } from '../../../paraglide/messages';
import { hasProblem } from '../../api/queries';
import { useApiClient } from '../../api/api-client-context';
import { useBrowser } from '../../core/browser';
import { stepUpWithPasskey } from '../passkeys/ceremonies';
import type { CeremonyFailure } from '../passkeys/ceremonies';
import { ceremonyFailureMessage } from '../passkeys/ceremony-messages';

interface StepUpContextValue {
    /**
     * Runs `action`; when the API answers `step-up-required`, asks for a fresh passkey check in a dialog and, once it
     * passed, runs `action` again. Cancelling rethrows the original failure.
     */
    readonly withStepUp: <T>(action: () => Promise<T>) => Promise<T>;
}

const StepUpContext = createContext<StepUpContextValue | null>(null);

type DialogState =
    | { readonly kind: 'closed' }
    | { readonly kind: 'open'; readonly running: boolean; readonly failure: CeremonyFailure | null };

/** Sensitive actions can require a sign-in or step-up within the last five minutes; the dashboard does it in place. */
export function StepUpProvider(props: { readonly children: ReactNode }) {
    const api = useApiClient();
    const { passkeys } = useBrowser();
    const [state, setState] = useState<DialogState>({ kind: 'closed' });
    const settle = useRef<((passed: boolean) => void) | null>(null);

    const finish = useCallback((passed: boolean) => {
        settle.current?.(passed);
        settle.current = null;
        setState({ kind: 'closed' });
    }, []);

    const confirm = useCallback(
        () =>
            new Promise<boolean>((resolve) => {
                settle.current?.(false);
                settle.current = resolve;
                setState({ kind: 'open', running: false, failure: null });
            }),
        [],
    );

    const value = useMemo<StepUpContextValue>(
        () => ({
            withStepUp: async (action) => {
                try {
                    return await action();
                } catch (error) {
                    if (!hasProblem(error, 'step-up-required') || !(await confirm())) {
                        throw error;
                    }
                    return action();
                }
            },
        }),
        [confirm],
    );

    const verify = async () => {
        setState({ kind: 'open', running: true, failure: null });
        const result = await stepUpWithPasskey({ api, passkeys });
        if (result.kind === 'ok') {
            finish(true);
        } else {
            setState({ kind: 'open', running: false, failure: result.failure });
        }
    };

    const open = state.kind === 'open';
    return (
        <StepUpContext value={value}>
            {props.children}
            <Dialog
                open={open}
                onClose={() => {
                    finish(false);
                }}
                title={m.step_up_title()}
                description={m.step_up_body()}
                footer={
                    <>
                        <Button
                            onClick={() => {
                                finish(false);
                            }}
                        >
                            {m.step_up_cancel()}
                        </Button>
                        <Button variant="primary" loading={open && state.running} onClick={() => void verify()}>
                            {open && state.failure !== null ? m.passkey_try_again() : m.step_up_continue()}
                        </Button>
                    </>
                }
            >
                {open && state.failure !== null ? (
                    <Banner tone="danger">{ceremonyFailureMessage(state.failure, 'authenticate')}</Banner>
                ) : null}
            </Dialog>
        </StepUpContext>
    );
}

export function useStepUp(): StepUpContextValue {
    const value = use(StepUpContext);
    if (value === null) {
        throw new Error('useStepUp needs a StepUpProvider');
    }
    return value;
}
