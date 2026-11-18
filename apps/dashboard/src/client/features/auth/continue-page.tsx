import { Banner, BrandRobot, Button } from '@ptbk/ui';
import { useCallback, useEffect, useState } from 'react';

import { m } from '../../../paraglide/messages';
import type { SessionView } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { useBrowser } from '../../core/browser';
import { Link } from '../../core/link';
import type { CeremonyFailure } from '../passkeys/ceremonies';
import { signInWithPasskey } from '../passkeys/ceremonies';
import { ceremonyFailureMessage } from '../passkeys/ceremony-messages';
import { useCompleteSignIn } from '../session/end-session';
import { EmailStep } from './email-step';

/**
 * `/continue`: one screen to sign in or create an account. Continue always sends the email, which the server answers
 * the same for every address: a sign-in and recovery note to an existing account, a link to finish creating one to a
 * new address. A passkey this browser has signs in from the email field's autofill without any mail. Continue opens no
 * passkey picker: for someone new it would only offer a phone they don't need (Seb, 2026-11-18). "Use a passkey" opens
 * it on purpose, for a passkey on a phone or in a password manager.
 */
export function ContinuePage(props: { readonly returnTo: string | undefined }) {
    const api = useApiClient();
    const { passkeys } = useBrowser();
    const completeSignIn = useCompleteSignIn();
    const signedIn = useCallback(
        (session: SessionView) => completeSignIn(session, props.returnTo ?? '/'),
        [completeSignIn, props.returnTo],
    );
    const [failure, setFailure] = useState<CeremonyFailure | null>(null);
    const [prompting, setPrompting] = useState(false);
    // The picker aborts the autofill request; a new key arms a fresh one once the picker is closed.
    const [autofillRound, setAutofillRound] = useState(0);
    const promptForPasskey = async (): Promise<void> => {
        setPrompting(true);
        setFailure(null);
        const result = await signInWithPasskey({ api, passkeys });
        if (result.kind === 'ok') {
            await signedIn(result.value);
            return;
        }
        setPrompting(false);
        setFailure(result.failure);
        setAutofillRound((round) => round + 1);
    };

    return (
        <EmailStep
            purpose="continue"
            illustration={<BrandRobot pose="working" size="md" />}
            title={m.continue_title()}
            intro={
                <>
                    <p className="font-medium">{m.signup_value()}</p>
                    <p className="text-text-muted">{m.continue_body()}</p>
                </>
            }
            hint={<p className="text-sm text-text-muted">{m.continue_passkey_hint()}</p>}
            autoComplete="username webauthn"
            submitLabel={m.continue_action()}
            formAddon={
                <>
                    {failure === null ? null : (
                        <Banner tone="danger" title={m.passkey_error_title()}>
                            {ceremonyFailureMessage(failure, 'authenticate')}
                        </Banner>
                    )}
                    <PasskeyAutofill key={autofillRound} onSignedIn={signedIn} onFailed={setFailure} />
                </>
            }
            secondaryAction={
                <Button
                    variant="ghost"
                    size="lg"
                    loading={prompting}
                    onClick={() => {
                        void promptForPasskey();
                    }}
                >
                    {m.continue_use_passkey()}
                </Button>
            }
            footer={
                <p className="border-t border-hairline pt-5 text-sm text-text-muted">
                    {m.continue_lost_device()} <Link to="/recover">{m.continue_recover()}</Link>
                </p>
            }
        />
    );
}

/**
 * Offers this browser's passkeys in the email field's autofill while the field is on screen. "Use a passkey" aborts
 * this request, which then ends as `cancelled` and says nothing. An expired challenge re-arms it.
 */
function PasskeyAutofill(props: {
    readonly onSignedIn: (session: SessionView) => Promise<void>;
    readonly onFailed: (failure: CeremonyFailure) => void;
}) {
    const api = useApiClient();
    const { passkeys } = useBrowser();
    const { onSignedIn, onFailed } = props;
    useEffect(() => {
        let active = true;
        // A function, so the checks after each await read the variable anew instead of a narrowed copy.
        const unmounted = () => !active;
        async function arm(): Promise<void> {
            if (!(await passkeys.supportsAutofill()) || unmounted()) {
                return;
            }
            const result = await signInWithPasskey({ api, passkeys }, 'autofill');
            if (unmounted()) {
                return;
            }
            if (result.kind === 'ok') {
                await onSignedIn(result.value);
                return;
            }
            const { failure: failed } = result;
            if (failed.kind === 'passkey' && failed.reason === 'cancelled') {
                return;
            }
            if (failed.kind === 'api' && failed.code === 'challenge-invalid') {
                await arm();
                return;
            }
            onFailed(failed);
        }
        void arm();
        return () => {
            active = false;
        };
    }, [api, passkeys, onSignedIn, onFailed]);
    return null;
}
