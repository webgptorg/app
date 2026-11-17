import { Banner, Button, Card, Skeleton, useLocale } from '@ptbk/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { ArrowRight, ArrowUpRight, CircleCheck, KeyRound } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { m } from '../../../paraglide/messages';
import { apiRoutes } from '../../../shared/api/routes';
import type { SessionView, TeamView } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { dataOrThrow, problemCode, queryKeys, sessionQuery } from '../../api/queries';
import { useBrowser } from '../../core/browser';
import { ButtonLink, Link } from '../../core/link';
import { useAppMutation } from '../../core/mutations';
import type { FragmentToken } from '../auth/fragment-token';
import { ceremonyFailureMessage } from '../passkeys/ceremony-messages';
import { joinFromInvite, type InviteJoined } from '../passkeys/ceremonies';
import { useCeremony } from '../passkeys/use-ceremony';
import { useOpenTeam } from './open-team';
import { teamsQuery } from './team-queries';

/** Long enough to read the one line about the engine's own passkey before the browser leaves for it. */
export const CONTINUE_DELAY_MS = 2500;

interface Preview {
    readonly orgName: string | null;
    readonly teamNames: readonly string[];
    readonly email: string;
    readonly expiresAt: number;
    readonly hasAccount: boolean;
}

/**
 * `/invites#<token>`: join the organization in one step, then on into its engine (D-31). Someone new creates their
 * account and passkey right here, someone with an account signs in here, and either way the same request accepts the
 * invitation. The token stays in memory, never in the address bar or storage; the server also keeps it in a
 * short-lived `__Host-` cookie, so a reload or another tab still finds the invitation.
 */
export function InvitePage(props: { readonly token: FragmentToken }) {
    const api = useApiClient();
    const router = useRouter();
    const queryClient = useQueryClient();
    const session = useQuery(sessionQuery(api));
    const token = props.token.kind === 'token' ? props.token.token : null;
    const [joined, setJoined] = useState<readonly string[] | null>(null);
    const preview = useQuery({
        queryKey: ['invite-preview', token],
        queryFn: async ({ signal }): Promise<Preview> =>
            dataOrThrow(await api.call(apiRoutes.previewInvite, { body: token === null ? {} : { token } }, signal)),
        enabled: props.token.kind !== 'malformed' && joined === null,
        retry: false,
    });

    const onJoined = useCallback(
        async (teamIds: readonly string[], newSession?: SessionView) => {
            router.options.context.fragmentTokens.forget('invite');
            setJoined(teamIds);
            // The person may now be in another organization: nothing cached about the previous one still holds.
            queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'invite-preview' });
            if (newSession !== undefined) {
                queryClient.setQueryData(queryKeys.session, newSession);
            }
            await queryClient.invalidateQueries({ queryKey: queryKeys.session });
        },
        [router, queryClient],
    );
    const refetchPreview = useCallback(() => {
        void preview.refetch();
    }, [preview]);

    function body() {
        if (joined !== null) {
            return <Joined teamIds={joined} />;
        }
        if (props.token.kind === 'malformed' || preview.isError) {
            return <Invalid signedIn={session.data != null} />;
        }
        if (preview.isPending || session.isPending) {
            return (
                <div>
                    <span className="sr-only">{m.loading()}</span>
                    <Skeleton className="h-48 w-full" />
                </div>
            );
        }
        const signedIn = session.data ?? null;
        return (
            <div className="flex flex-col gap-6">
                <InviteSummary preview={preview.data} />
                {signedIn === null ? (
                    <JoinCeremony
                        // A new mode starts with a clean slate, not the failure that revealed it.
                        key={preview.data.hasAccount ? 'sign-in' : 'new-account'}
                        token={token}
                        preview={preview.data}
                        onJoined={(result) => onJoined(result.joined.teamIds, result.session)}
                        onStale={refetchPreview}
                    />
                ) : (
                    <AcceptAsSignedIn token={token} preview={preview.data} session={signedIn} onJoined={onJoined} />
                )}
            </div>
        );
    }

    return body();
}

function InviteSummary(props: { readonly preview: Preview }) {
    const locale = useLocale();
    const { preview } = props;
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
                <h1 className="text-2xl font-semibold tracking-display">
                    {preview.orgName === null
                        ? m.invite_join_title_unnamed()
                        : m.invite_join_title({ org: preview.orgName })}
                </h1>
                <p className="text-text-muted">
                    {preview.orgName === null
                        ? m.invite_page_body_unnamed()
                        : m.invite_page_body({ org: preview.orgName })}
                </p>
            </div>
            {preview.teamNames.length === 0 ? null : (
                <Card title={m.invite_page_teams()} className="gap-2 p-4">
                    <ul className="flex flex-col gap-1">
                        {preview.teamNames.map((name) => (
                            <li key={name} className="font-medium">
                                {name}
                            </li>
                        ))}
                    </ul>
                </Card>
            )}
            <p className="text-sm text-text-muted">
                {m.invite_page_for({
                    email: preview.email,
                    until: locale.formatDateTime(new Date(preview.expiresAt)),
                })}
            </p>
        </div>
    );
}

function joinLabel(preview: Preview): string {
    return preview.orgName === null ? m.invite_join_action_unnamed() : m.invite_join_action({ org: preview.orgName });
}

/** Signed out: one button that makes the account (or signs in) and joins. */
function JoinCeremony(props: {
    readonly token: string | null;
    readonly preview: Preview;
    readonly onJoined: (result: InviteJoined) => Promise<void>;
    /** The preview no longer holds: the address got an account, or the invitation was used up. */
    readonly onStale: () => void;
}) {
    const api = useApiClient();
    const { passkeys } = useBrowser();
    const mode = props.preview.hasAccount ? 'sign-in' : 'new-account';
    const ceremony = useCallback(
        () => joinFromInvite({ api, passkeys }, mode, props.token),
        [api, passkeys, mode, props.token],
    );
    const { state, start } = useCeremony(ceremony, props.onJoined);
    const code = state.kind === 'failed' && state.failure.kind === 'api' ? state.failure.code : null;
    const { onStale } = props;
    useEffect(() => {
        if (code === 'account-exists' || code === 'invite-invalid') {
            onStale();
        }
    }, [code, onStale]);
    return (
        <div className="flex flex-col gap-5">
            <p>
                {mode === 'new-account'
                    ? m.invite_join_new_body({ email: props.preview.email })
                    : m.invite_join_existing_body({ email: props.preview.email })}
            </p>
            {state.kind === 'failed' && code !== 'account-exists' ? (
                <Banner tone="danger" title={m.passkey_error_title()}>
                    {code === 'email-mismatch'
                        ? m.invite_join_mismatch({ email: props.preview.email })
                        : ceremonyFailureMessage(state.failure, mode === 'new-account' ? 'register' : 'authenticate')}
                </Banner>
            ) : null}
            <Button variant="primary" size="lg" loading={state.kind === 'running'} onClick={start}>
                <KeyRound aria-hidden className="size-4" />
                {state.kind === 'failed'
                    ? m.passkey_try_again()
                    : mode === 'new-account'
                      ? joinLabel(props.preview)
                      : m.invite_join_sign_in()}
            </Button>
            <p className="text-sm text-text-muted">
                {mode === 'new-account' ? (
                    m.invite_join_passkey_hint()
                ) : (
                    <>
                        {m.signin_lost_passkey()} <Link to="/recover">{m.signin_recover()}</Link>
                    </>
                )}
            </p>
        </div>
    );
}

/** Signed in already: accept as that account, or, for another address, sign out here and join as the invited one. */
function AcceptAsSignedIn(props: {
    readonly token: string | null;
    readonly preview: Preview;
    readonly session: SessionView;
    readonly onJoined: (teamIds: readonly string[]) => Promise<void>;
}) {
    const api = useApiClient();
    const queryClient = useQueryClient();
    const accept = useAppMutation({
        mutationFn: async () => {
            const joined = dataOrThrow(
                await api.call(apiRoutes.acceptInvite, { body: props.token === null ? {} : { token: props.token } }),
            );
            dataOrThrow(await api.call(apiRoutes.setActiveOrg, { body: { orgId: joined.orgId } }));
            return joined.teamIds;
        },
        errorMessage: (error) => {
            const code = problemCode(error);
            if (code === 'email-mismatch') {
                return m.invite_page_mismatch({ email: props.preview.email });
            }
            return code === 'invite-invalid' ? m.invite_page_invalid() : undefined;
        },
        onSuccess: props.onJoined,
    });
    // Stays on this page: the sign-in or join that follows happens right here.
    const signOut = useAppMutation({
        mutationFn: async () => {
            const outcome = await api.call(apiRoutes.signout, {});
            if (outcome.kind === 'problem' && outcome.code !== 'unauthorized') {
                dataOrThrow(outcome);
            }
        },
        onSuccess: () => {
            queryClient.setQueryData(queryKeys.session, null);
        },
    });
    if (props.session.user.email.toLowerCase() !== props.preview.email) {
        return (
            <div className="flex flex-col gap-4">
                <Banner tone="warning">
                    {m.invite_join_other_account({ current: props.session.user.email, email: props.preview.email })}
                </Banner>
                <Button
                    variant="primary"
                    size="lg"
                    loading={signOut.isPending}
                    onClick={() => {
                        signOut.mutate();
                    }}
                >
                    {m.invite_join_sign_out()}
                </Button>
            </div>
        );
    }
    return (
        <div className="flex flex-col gap-5">
            <p>{m.invite_join_signed_in({ email: props.session.user.email })}</p>
            <Button
                variant="primary"
                size="lg"
                loading={accept.isPending}
                onClick={() => {
                    accept.mutate();
                }}
            >
                {joinLabel(props.preview)}
            </Button>
        </div>
    );
}

/** After joining: straight on to the one engine, a list of several, or the dashboard when there is none yet. */
function Joined(props: { readonly teamIds: readonly string[] }) {
    const api = useApiClient();
    const teams = useQuery(teamsQuery(api));
    if (teams.isPending) {
        return (
            <div>
                <span className="sr-only">{m.loading()}</span>
                <Skeleton className="h-32 w-full" />
            </div>
        );
    }
    const engines = (teams.data ?? []).filter(
        (team) => props.teamIds.includes(team.teamId) && team.engineId !== null && team.isMember,
    );
    const [only, ...others] = engines;
    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
                <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-display">
                    <CircleCheck aria-hidden className="size-6 shrink-0 text-success" />
                    {m.invite_joined_title()}
                </h1>
                {only === undefined ? <p className="text-text-muted">{m.invite_joined_no_engine()}</p> : null}
            </div>
            {only === undefined ? (
                <ButtonLink to="/" variant="primary" size="lg">
                    {m.invite_joined_dashboard()}
                </ButtonLink>
            ) : others.length === 0 ? (
                <ContinueToEngine team={only} />
            ) : (
                <EngineChoices teams={engines} />
            )}
        </div>
    );
}

function ContinueToEngine(props: { readonly team: TeamView }) {
    const { mutate, isPending, isError } = useOpenTeam(props.team.teamId);
    useEffect(() => {
        const timer = setTimeout(() => {
            mutate();
        }, CONTINUE_DELAY_MS);
        return () => {
            clearTimeout(timer);
        };
    }, [mutate]);
    return (
        <div className="flex flex-col gap-5">
            <p>{m.invite_joined_next_passkey()}</p>
            <Button
                variant="primary"
                size="lg"
                loading={isPending}
                onClick={() => {
                    mutate();
                }}
            >
                {m.invite_joined_continue({ engine: props.team.name })}
                <ArrowRight aria-hidden className="size-4" />
            </Button>
            {isError ? null : (
                <p className="text-center text-sm text-text-muted" aria-live="polite">
                    {m.invite_joined_taking_you({ engine: props.team.name })}
                </p>
            )}
        </div>
    );
}

function EngineChoices(props: { readonly teams: readonly TeamView[] }) {
    return (
        <div className="flex flex-col gap-3">
            <p>{m.invite_joined_choose()}</p>
            <ul className="flex flex-col gap-2">
                {props.teams.map((team) => (
                    <li key={team.teamId}>
                        <Card as="div" className="flex-row items-center justify-between gap-3 p-3 pl-4">
                            <span className="font-medium">{team.name}</span>
                            <OpenEngine team={team} />
                        </Card>
                    </li>
                ))}
            </ul>
        </div>
    );
}

function OpenEngine(props: { readonly team: TeamView }) {
    const open = useOpenTeam(props.team.teamId);
    return (
        <Button
            variant="secondary"
            size="sm"
            loading={open.isPending}
            aria-label={m.team_open_named({ name: props.team.name })}
            onClick={() => {
                open.mutate();
            }}
        >
            {m.team_open()}
            <ArrowUpRight aria-hidden className="size-4" />
        </Button>
    );
}

function Invalid(props: { readonly signedIn: boolean }) {
    return (
        <div className="flex flex-col gap-4">
            <h1 className="text-2xl font-semibold tracking-display">{m.invite_page_title()}</h1>
            <Banner tone="warning">{m.invite_page_invalid()}</Banner>
            {props.signedIn ? (
                <ButtonLink to="/" variant="secondary">
                    {m.invite_joined_dashboard()}
                </ButtonLink>
            ) : null}
        </div>
    );
}
