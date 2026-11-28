import { Button } from '@ptbk/ui';
import { useMutation } from '@tanstack/react-query';

import { m } from '../../../paraglide/messages';
import { notificationRoutes } from '../../../shared/api/notification-routes';
import { useApiClient } from '../../api/api-client-context';
import { Link } from '../../core/link';
import { useFragmentToken } from '../auth/use-fragment-token';
import { NOTIFICATION_SETTINGS_ANCHOR } from './notification-settings';

const TITLE = 'text-2xl font-semibold tracking-display';

/**
 * `/unsubscribe#<token>`, an email's "Turn these emails off" link, signed in or not. Opening it changes nothing: link
 * scanners in mail systems follow every link, so only the button posts. The token never leaves the fragment except in
 * that one request.
 */
export function UnsubscribePage() {
    const token = useFragmentToken('unsubscribe');
    const api = useApiClient();
    const stop = useMutation({
        mutationFn: (value: string) => api.call(notificationRoutes.unsubscribe, { query: { token: value } }),
    });
    const outcome = stop.data;
    if (token.kind !== 'token' || (outcome?.kind === 'problem' && outcome.code === 'invalid-token')) {
        return <Outcome title={m.unsubscribe_invalid_title()} body={m.unsubscribe_invalid_body()} />;
    }
    if (outcome?.kind === 'ok') {
        return <Outcome title={m.unsubscribe_done_title()} body={m.unsubscribe_done_body()} />;
    }
    const failure =
        outcome === undefined
            ? null
            : outcome.kind === 'network-error'
              ? m.api_error_unreachable()
              : outcome.kind === 'problem' && outcome.code === 'rate-limited'
                ? m.api_error_rate_limited()
                : m.error_mutation_failed();
    return (
        <div className="flex flex-col gap-4">
            <h1 className={TITLE}>{m.unsubscribe_title()}</h1>
            <p className="text-text-muted">{m.unsubscribe_body()}</p>
            <Button
                variant="primary"
                className="self-start"
                loading={stop.isPending}
                onClick={() => {
                    stop.mutate(token.token);
                }}
            >
                {m.unsubscribe_confirm()}
            </Button>
            {failure === null ? null : (
                <p role="alert" className="text-sm text-danger">
                    {failure}
                </p>
            )}
        </div>
    );
}

function Outcome(props: { readonly title: string; readonly body: string }) {
    return (
        <div className="flex flex-col gap-4">
            <h1 className={TITLE}>{props.title}</h1>
            <p className="text-text-muted">{props.body}</p>
            {/* Signed out, the account area signs in first and comes back here. */}
            <Link to="/account" hash={NOTIFICATION_SETTINGS_ANCHOR} variant="standalone" className="font-medium">
                {m.unsubscribe_settings()}
            </Link>
        </div>
    );
}
