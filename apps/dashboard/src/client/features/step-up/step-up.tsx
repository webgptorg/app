import { Banner, Button, Dialog } from '@ptbk/ui';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, use, useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { m } from '../../../paraglide/messages';
import type { SessionView } from '../../../shared/api/routes';
import { hasProblem, queryKeys } from '../../api/queries';
import { useApiClient } from '../../api/api-client-context';
import { useBrowser } from '../../core/browser';
import { usePasskeyPrompt } from '../passkeys/use-passkey-prompt';
import type { WaitForPasskey } from '../passkeys/passkey-authenticator';
import { stepUpWithPasskey } from '../passkeys/ceremonies';
import type { CeremonyFailure } from '../passkeys/ceremonies';
import { ceremonyFailureMessage } from '../passkeys/ceremony-messages';

/** A passkey check run in place failed; the screen that asked for it says why, where the person is. */
export class StepUpFailedError extends Error {
    readonly failure: CeremonyFailure;

    constructor(failure: CeremonyFailure) {
        super('Step-up failed');
        this.name = 'StepUpFailedError';
        this.failure = failure;
    }
}

/**
 * `dialog`: a `step-up-required` answer opens the step-up dialog. `in-place`: for an action confirmed in a dialog
 * already, the passkey check runs straight away, so two modals never stack; a failed check throws
 * {@link StepUpFailedError}.
 */
export type StepUpMode = 'dialog' | { readonly inPlace: WaitForPasskey };

interface StepUpContextValue {
    /**
     * Runs `action`; when the API answers `step-up-required`, asks for a fresh passkey check and, once it passed, runs
     * `action` again. Cancelling the dialog rethrows the original failure.
     */
    readonly withStepUp: <T>(action: () => Promise<T>, mode?: StepUpMode) => Promise<T>;
    /** Whether a sensitive action would need a fresh passkey check now. */
    readonly needsStepUp: () => boolean;
    /** The passkey check on its own, without a dialog; throws {@link StepUpFailedError} when it fails. */
    readonly stepUpInPlace: (waitForPrompt: WaitForPasskey) => Promise<void>;
}

const StepUpContext = createContext<StepUpContextValue | null>(null);

type DialogState =
    | { readonly kind: 'closed' }
    | { readonly kind: 'open'; readonly running: boolean; readonly failure: CeremonyFailure | null };

/** Sensitive actions can require a sign-in or step-up within the last five minutes; the dashboard does it in place. */
export function StepUpProvider(props: { readonly children: ReactNode }) {
    const api = useApiClient();
    const { passkeys, now } = useBrowser();
    const queryClient = useQueryClient();
    const [state, setState] = useState<DialogState>({ kind: 'closed' });
    const { waitForPrompt, reopen } = usePasskeyPrompt(state.kind === 'open');
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

    const stepUpInPlace = useCallback(
        async (waitForPrompt: WaitForPasskey) => {
            const result = await stepUpWithPasskey({ api, passkeys, waitForPrompt });
            if (result.kind === 'failed') {
                throw new StepUpFailedError(result.failure);
            }
            // So the next sensitive action within the window goes straight through, without asking again.
            queryClient.setQueryData<SessionView | null>(queryKeys.session, (session) =>
                session === undefined || session === null ? session : { ...session, steppedUpUntil: result.value },
            );
        },
        [api, passkeys, queryClient],
    );

    const value = useMemo<StepUpContextValue>(
        () => ({
            withStepUp: async (action, mode = 'dialog') => {
                try {
                    return await action();
                } catch (error) {
                    if (!hasProblem(error, 'step-up-required')) {
                        throw error;
                    }
                    if (mode !== 'dialog') {
                        await stepUpInPlace(mode.inPlace);
                    } else if (!(await confirm())) {
                        throw error;
                    }
                    return action();
                }
            },
            needsStepUp: () => {
                const until = queryClient.getQueryData<SessionView | null>(queryKeys.session)?.steppedUpUntil ?? null;
                return until === null || until <= now();
            },
            stepUpInPlace,
        }),
        [confirm, stepUpInPlace, queryClient, now],
    );

    const verify = async () => {
        const request = settle.current;
        setState({ kind: 'open', running: true, failure: null });
        const result = await stepUpWithPasskey({ api, passkeys, waitForPrompt });
        if (settle.current !== request) return;
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
                        <Button
                            variant="primary"
                            loading={open && state.running && reopen === null}
                            onClick={reopen ?? (() => void verify())}
                        >
                            {reopen !== null
                                ? m.passkey_reopen_prompt()
                                : open && state.failure !== null
                                  ? m.passkey_try_again()
                                  : m.step_up_continue()}
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
