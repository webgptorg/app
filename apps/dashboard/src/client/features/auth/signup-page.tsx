import { Button, EmptyState } from '@ptbk/ui';
import { Link2Off } from 'lucide-react';
import { useCallback, useState } from 'react';

import { m } from '../../../paraglide/messages';
import type { SessionView } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { useBrowser } from '../../core/browser';
import { Link } from '../../core/link';
import { registerWithEmailToken } from '../passkeys/ceremonies';
import { useCeremony } from '../passkeys/use-ceremony';
import { useCompleteSignIn } from '../session/end-session';
import { CeremonyPanel } from './ceremony-panel';
import { EmailStep } from './email-step';
import type { FragmentToken } from './fragment-token';

/** `/signup`: the email step, or with an emailed token (taken from the fragment by the route) the passkey step. */
export function SignUpPage(props: { readonly initialToken: FragmentToken }) {
    const [token, setToken] = useState(props.initialToken);
    switch (token.kind) {
        case 'none':
            return (
                <EmailStep
                    purpose="signup"
                    title={m.signup_title()}
                    intro={
                        <>
                            <p className="font-medium">{m.signup_value()}</p>
                            <p className="text-text-muted">{m.signup_body()}</p>
                        </>
                    }
                    submitLabel={m.signup_email_action()}
                    footer={
                        <p className="text-sm">
                            {m.signup_have_account()} <Link to="/signin">{m.signup_sign_in()}</Link>
                        </p>
                    }
                />
            );
        case 'malformed':
            return (
                <LinkExpired
                    onRestart={() => {
                        setToken({ kind: 'none' });
                    }}
                />
            );
        case 'token':
            return (
                <SignUpPasskeyStep
                    token={token.token}
                    onRestart={() => {
                        setToken({ kind: 'none' });
                    }}
                />
            );
    }
}

function SignUpPasskeyStep(props: { readonly token: string; readonly onRestart: () => void }) {
    const api = useApiClient();
    const { passkeys } = useBrowser();
    const completeSignIn = useCompleteSignIn();
    const ceremony = useCallback(
        () => registerWithEmailToken({ api, passkeys }, 'signup', props.token),
        [api, passkeys, props.token],
    );
    const onRegistered = useCallback((session: SessionView) => completeSignIn(session, '/'), [completeSignIn]);
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
