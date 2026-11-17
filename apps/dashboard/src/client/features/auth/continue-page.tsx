import { Banner, BrandRobot } from '@ptbk/ui';
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
 * `/continue`: one screen to sign in or create an account. A passkey this browser has signs in from the email field's
 * autofill, or from the prompt Continue opens. Only when that does not work does Continue ask the server for an email,
 * which answers the same for every address: a sign-in and recovery note to an existing account, a link to finish
 * creating one to a new address. Someone with a passkey therefore never gets mail for signing in.
 */
export function ContinuePage(props: { readonly returnTo: string | undefined }) {
    const api = useApiClient();
    const { passkeys } = useBrowser();
    const completeSignIn = useCompleteSignIn();
    const signedIn = useCallback(
        (session: SessionView) => completeSignIn(session, props.returnTo ?? '/'),
        [completeSignIn, props.returnTo],
    );
    const tryPasskey = useCallback(async (): Promise<CeremonyFailure | null> => {
        const result = await signInWithPasskey({ api, passkeys });
        if (result.kind === 'failed') {
            return result.failure;
        }
        await signedIn(result.value);
        return null;
    }, [api, passkeys, signedIn]);

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
            beforeSend={async () => ((await tryPasskey()) === null ? 'signed-in' : 'send')}
            formAddon={<PasskeyAutofill onSignedIn={signedIn} />}
            retry={{
                label: m.continue_retry_passkey(),
                onRetry: async () => {
                    const failure = await tryPasskey();
                    return failure === null ? null : ceremonyFailureMessage(failure, 'authenticate');
                },
            }}
            footer={
                <p className="border-t border-hairline pt-5 text-sm text-text-muted">
                    {m.continue_lost_device()} <Link to="/recover">{m.continue_recover()}</Link>
                </p>
            }
        />
    );
}

/**
 * Offers this browser's passkeys in the email field's autofill while the field is on screen. Continue's own prompt
 * aborts this request, which then ends as `cancelled` and says nothing. An expired challenge re-arms it.
 */
function PasskeyAutofill(props: { readonly onSignedIn: (session: SessionView) => Promise<void> }) {
    const api = useApiClient();
    const { passkeys } = useBrowser();
    const { onSignedIn } = props;
    const [failure, setFailure] = useState<CeremonyFailure | null>(null);
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
            setFailure(failed);
        }
        void arm();
        return () => {
            active = false;
        };
    }, [api, passkeys, onSignedIn]);
    return failure === null ? null : (
        <Banner tone="danger" title={m.passkey_error_title()}>
            {ceremonyFailureMessage(failure, 'authenticate')}
        </Banner>
    );
}
