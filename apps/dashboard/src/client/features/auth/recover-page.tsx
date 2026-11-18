import { Banner } from '@ptbk/ui';
import { useCallback, useState } from 'react';

import { m } from '../../../paraglide/messages';
import type { SessionView } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { useBrowser } from '../../core/browser';
import { Link } from '../../core/link';
import { CooldownBanner } from '../account/cooldown-banner';
import { registerWithEmailToken } from '../passkeys/ceremonies';
import { InviteOffers } from '../teams/invite-offers';
import { useCeremony } from '../passkeys/use-ceremony';
import { useCompleteSignIn } from '../session/end-session';
import { CeremonyPanel } from './ceremony-panel';
import { EmailStep } from './email-step';
import type { FragmentToken } from './fragment-token';
import { LinkExpired } from './signup-page';

type RecoverState = FragmentToken | { readonly kind: 'recovered'; readonly session: SessionView };

/**
 * `/recover`: the email step, or with an emailed token the new passkey. Recovery signs out every other session and
 * starts the 72-hour cooldown, so the end screen says so and sends the person to review their passkeys.
 */
export function RecoverPage(props: { readonly initialToken: FragmentToken }) {
    const [state, setState] = useState<RecoverState>(props.initialToken);
    const restart = useCallback(() => {
        setState({ kind: 'none' });
    }, []);
    const recovered = useCallback((session: SessionView) => {
        setState({ kind: 'recovered', session });
    }, []);
    switch (state.kind) {
        case 'none':
            return (
                <EmailStep
                    purpose="recovery"
                    title={m.recover_title()}
                    intro={<p className="text-text-muted">{m.recover_body()}</p>}
                    submitLabel={m.recover_email_action()}
                    footer={
                        <p className="border-t border-hairline pt-5 text-sm text-text-muted">
                            {m.recover_remembered()} <Link to="/continue">{m.signup_sign_in()}</Link>
                        </p>
                    }
                />
            );
        case 'malformed':
            return <LinkExpired onRestart={restart} />;
        case 'token':
            return <RecoverPasskeyStep token={state.token} onRestart={restart} onRecovered={recovered} />;
        case 'recovered':
            return <Recovered session={state.session} />;
    }
}

function RecoverPasskeyStep(props: {
    readonly token: string;
    readonly onRestart: () => void;
    readonly onRecovered: (session: SessionView) => void;
}) {
    const api = useApiClient();
    const { passkeys } = useBrowser();
    const completeSignIn = useCompleteSignIn();
    const { onRecovered } = props;
    const ceremony = useCallback(
        () => registerWithEmailToken({ api, passkeys }, 'recovery', props.token),
        [api, passkeys, props.token],
    );
    const onRegistered = useCallback(
        async (session: SessionView) => {
            await completeSignIn(session);
            onRecovered(session);
        },
        [completeSignIn, onRecovered],
    );
    const { state, start } = useCeremony(ceremony, onRegistered);
    if (state.kind === 'failed' && state.failure.kind === 'api' && state.failure.code === 'token-invalid') {
        return <LinkExpired onRestart={props.onRestart} />;
    }
    return (
        <CeremonyPanel
            title={m.recover_passkey_title()}
            description={
                <>
                    <p>{m.recover_passkey_body()}</p>
                    <p className="text-sm">{m.recover_passkey_consequences()}</p>
                </>
            }
            actionLabel={m.recover_passkey_action()}
            kind="register"
            state={state}
            onStart={start}
        />
    );
}

function Recovered(props: { readonly session: SessionView }) {
    const { now } = useBrowser();
    return (
        <div className="flex flex-col gap-4">
            <h1 className="text-2xl font-semibold tracking-display">{m.recovered_title()}</h1>
            <Banner tone="success">{m.recovered_body()}</Banner>
            <CooldownBanner endsAt={props.session.user.recoveryCooldownEndsAt} now={now()} />
            <InviteOffers />
            <p>{m.recovered_next()}</p>
            <Link to="/account" variant="standalone" className="font-medium">
                {m.recovered_review_passkeys()}
            </Link>
        </div>
    );
}
