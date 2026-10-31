import { Banner, Button, Skeleton, useLocale } from '@ptbk/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouter } from '@tanstack/react-router';

import { m } from '../../../paraglide/messages';
import { apiRoutes } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { dataOrThrow, problemCode, sessionQuery } from '../../api/queries';
import { ButtonLink } from '../../core/link';
import { useAppMutation } from '../../core/mutations';
import type { FragmentToken } from '../auth/fragment-token';

/**
 * `/invites#<token>`: what the invitation is for, then sign in and accept. The token stays in memory (never in the
 * address bar or storage), so a sign-in in this tab comes back to it; after a new sign-up, the emailed link is opened
 * again.
 */
export function InvitePage(props: { readonly token: FragmentToken }) {
    const api = useApiClient();
    const router = useRouter();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const locale = useLocale();
    const session = useQuery(sessionQuery(api));
    const token = props.token.kind === 'token' ? props.token.token : null;
    const preview = useQuery({
        queryKey: ['invite-preview', token],
        queryFn: async ({ signal }) =>
            dataOrThrow(await api.call(apiRoutes.previewInvite, { body: { token: token ?? '' } }, signal)),
        enabled: token !== null,
        retry: false,
    });
    const accept = useAppMutation({
        mutationFn: async () => {
            const { orgId } = dataOrThrow(await api.call(apiRoutes.acceptInvite, { body: { token: token ?? '' } }));
            dataOrThrow(await api.call(apiRoutes.setActiveOrg, { body: { orgId } }));
        },
        errorMessage: (error) => {
            const code = problemCode(error);
            if (code === 'email-mismatch') {
                return m.invite_page_mismatch({ email: preview.data?.email ?? '' });
            }
            return code === 'invite-invalid' ? m.invite_page_invalid() : undefined;
        },
        onSuccess: async () => {
            router.options.context.fragmentTokens.forget('invite');
            await queryClient.invalidateQueries();
            await navigate({ to: '/teams' });
        },
    });

    function body() {
        if (token === null || preview.isError) {
            return <Banner tone="warning">{m.invite_page_invalid()}</Banner>;
        }
        if (preview.isPending || session.isPending) {
            return (
                <div>
                    <span className="sr-only">{m.loading()}</span>
                    <Skeleton className="h-24 w-full" />
                </div>
            );
        }
        const { orgName, teamNames, email, expiresAt } = preview.data;
        return (
            <div className="flex flex-col gap-4">
                <p>{orgName === null ? m.invite_page_body_unnamed() : m.invite_page_body({ org: orgName })}</p>
                {teamNames.length === 0 ? null : (
                    <p className="text-sm">
                        <span className="text-text-muted">{m.invite_page_teams()} </span>
                        {teamNames.join(', ')}
                    </p>
                )}
                <p className="text-sm text-text-muted">
                    {m.invite_page_for({ email, until: locale.formatDateTime(new Date(expiresAt)) })}
                </p>
                {session.data === null || session.data === undefined ? (
                    <div className="flex flex-col gap-3">
                        <p className="text-sm">{m.invite_page_sign_in_first({ email })}</p>
                        <div className="flex flex-wrap gap-2">
                            <ButtonLink to="/signin" search={{ returnTo: '/invites' }} variant="primary">
                                {m.invite_page_sign_in()}
                            </ButtonLink>
                            <ButtonLink to="/signup" variant="secondary">
                                {m.invite_page_sign_up()}
                            </ButtonLink>
                        </div>
                    </div>
                ) : (
                    <div>
                        <Button
                            variant="primary"
                            loading={accept.isPending}
                            onClick={() => {
                                accept.mutate();
                            }}
                        >
                            {m.invite_page_accept()}
                        </Button>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <h1 className="font-display text-2xl font-semibold">{m.invite_page_title()}</h1>
            {body()}
        </div>
    );
}
