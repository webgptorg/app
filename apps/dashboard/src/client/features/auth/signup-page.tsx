import { Button, EmptyState } from '@ptbk/ui';
import { Link2Off } from 'lucide-react';
import { Navigate, useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';

import { m } from '../../../paraglide/messages';
import type { SessionView } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { useBrowser } from '../../core/browser';
import { registerWithEmailToken } from '../passkeys/ceremonies';
import { useCeremony } from '../passkeys/use-ceremony';
import { afterSignUp } from '../licensing/website-link-marker';
import { useCompleteSignIn } from '../session/end-session';
import { CeremonyPanel } from './ceremony-panel';
import type { FragmentToken } from './fragment-token';

/**
 * `/signup`: with an emailed token (taken from the fragment by the route) the passkey step that creates the account.
 * Without one there is nothing to do here: accounts start on Continue, and a malformed link offers the way back there.
 */
export function SignUpPage(props: { readonly initialToken: FragmentToken }) {
    const navigate = useNavigate();
    const restart = useCallback(() => {
        void navigate({ to: '/continue', replace: true });
    }, [navigate]);
    switch (props.initialToken.kind) {
        case 'none':
            return <Navigate to="/continue" replace />;
        case 'malformed':
            return <LinkExpired onRestart={restart} />;
        case 'token':
            return <SignUpPasskeyStep token={props.initialToken.token} onRestart={restart} />;
    }
}

function SignUpPasskeyStep(props: { readonly token: string; readonly onRestart: () => void }) {
    const api = useApiClient();
    const { passkeys, storage, now } = useBrowser();
    const completeSignIn = useCompleteSignIn();
    const ceremony = useCallback(
        () => registerWithEmailToken({ api, passkeys }, 'signup', props.token),
        [api, passkeys, props.token],
    );
    // Back to the ptbk.io link when this sign-up started there, even from the emailed link in a new tab.
    const onRegistered = useCallback(
        (session: SessionView) => completeSignIn(session, afterSignUp(storage, now()) ?? '/'),
        [completeSignIn, storage, now],
    );
    const { state, start } = useCeremony(ceremony, onRegistered);
    if (state.kind === 'failed' && state.failure.kind === 'api' && state.failure.code === 'token-invalid') {
        return <LinkExpired onRestart={props.onRestart} />;
    }
    return (
        <CeremonyPanel
            title={m.signup_passkey_title()}
            description={
                <>
                    <p>{m.signup_passkey_body()}</p>
                    <p className="text-sm">{m.passkey_what_is()}</p>
                </>
            }
            actionLabel={m.signup_passkey_action()}
            kind="register"
            state={state}
            onStart={start}
        />
    );
}

/** An emailed link that is malformed, used or older than 15 minutes; the remedy is a new one. */
export function LinkExpired(props: { readonly onRestart: () => void }) {
    return (
        <EmptyState
            icon={<Link2Off aria-hidden />}
            title={m.link_expired_title()}
            description={m.link_expired_body()}
            headingLevel={1}
            action={
                <Button variant="primary" onClick={props.onRestart}>
                    {m.link_expired_action()}
                </Button>
            }
        />
    );
}
