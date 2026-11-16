import { useCallback } from 'react';

import { m } from '../../../paraglide/messages';
import type { SessionView } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { useBrowser } from '../../core/browser';
import { Link } from '../../core/link';
import { signInWithPasskey } from '../passkeys/ceremonies';
import { useCeremony } from '../passkeys/use-ceremony';
import { useCompleteSignIn } from '../session/end-session';
import { CeremonyPanel } from './ceremony-panel';

/** Usernameless passkey sign-in; `returnTo` is already a vetted same-origin path (route search validation). */
export function SignInPage(props: { readonly returnTo: string | undefined }) {
    const api = useApiClient();
    const { passkeys } = useBrowser();
    const completeSignIn = useCompleteSignIn();
    const ceremony = useCallback(() => signInWithPasskey({ api, passkeys }), [api, passkeys]);
    const onSignedIn = useCallback(
        (session: SessionView) => completeSignIn(session, props.returnTo ?? '/'),
        [completeSignIn, props.returnTo],
    );
    const { state, start } = useCeremony(ceremony, onSignedIn);
    return (
        <CeremonyPanel
            title={m.signin_title()}
            description={<p>{m.signin_body()}</p>}
            actionLabel={m.signin_action()}
            kind="authenticate"
            state={state}
            onStart={start}
            footer={
                <ul className="flex flex-col gap-2 border-t border-hairline pt-5 text-sm text-text-muted">
                    <li>
                        {m.signin_no_account()} <Link to="/signup">{m.signin_create_account()}</Link>
                    </li>
                    <li>
                        {m.signin_lost_passkey()} <Link to="/recover">{m.signin_recover()}</Link>
                    </li>
                </ul>
            }
        />
    );
}
