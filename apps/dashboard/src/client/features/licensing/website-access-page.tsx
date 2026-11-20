import { Banner, Button, EmptyState, Skeleton } from '@ptbk/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { BadgeCheck, Link2Off } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { m } from '../../../paraglide/messages';
import { apiRoutes } from '../../../shared/api/routes';
import type { SessionView, WebsiteAccessError, WebsitePendingView } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { dataOrThrow, problemCode, queryKeys, sessionQuery, websitePendingQuery } from '../../api/queries';
import { useBrowser } from '../../core/browser';
import { ButtonLink } from '../../core/link';
import { EmailStep } from '../auth/email-step';
import { leaveSignedInArea } from '../session/end-session';
import { WEBSITE_ACCESS_START } from './license-page';
import { forgetWebsiteLink, rememberWebsiteLink, WEBSITE_ACCESS_PATH } from './website-link-marker';

const LINK_PERMISSION = 'license.link';

function Ended(props: { readonly error: WebsiteAccessError }) {
    const { navigate } = useBrowser();
    return (
        <EmptyState
            icon={<Link2Off aria-hidden />}
            title={props.error === 'failed' ? m.website_access_failed_title() : m.website_access_expired_title()}
            description={props.error === 'failed' ? m.website_access_failed_body() : m.website_access_expired_body()}
            headingLevel={1}
            action={
                <Button
                    variant="primary"
                    onClick={() => {
                        navigate(WEBSITE_ACCESS_START);
                    }}
                >
                    {m.website_access_retry()}
                </Button>
            }
        />
    );
}

function Titled(props: { readonly title: string; readonly children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-4">
            <h1 className="font-display text-2xl font-semibold">{props.title}</h1>
            {props.children}
        </div>
    );
}

/** Signed in: link at once when the address matches and the role may; otherwise say why not, and change nothing. */
function SignedIn(props: { readonly session: SessionView; readonly pending: WebsitePendingView }) {
    const api = useApiClient();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { storage } = useBrowser();
    const { session, pending } = props;
    const matches = session.user.email.toLowerCase() === pending.email.toLowerCase();
    const allowed = session.activeOrg.permissions.includes(LINK_PERMISSION);
    const org = session.activeOrg.name ?? session.user.email;
    const link = useMutation({
        mutationFn: async () => dataOrThrow(await api.call(apiRoutes.websiteAccessLink, {})),
        onSuccess: async () => {
            forgetWebsiteLink(storage);
            await queryClient.invalidateQueries({ queryKey: queryKeys.license });
        },
    });
    const started = useRef(false);
    useEffect(() => {
        if (matches && allowed && !started.current) {
            started.current = true;
            link.mutate();
        }
    }, [matches, allowed, link]);

    if (!matches || problemCode(link.error) === 'email-mismatch') {
        return (
            <Titled title={m.website_access_mismatch_title()}>
                <p>{m.website_access_mismatch_body({ current: session.user.email, website: pending.email })}</p>
                <div>
                    <Button
                        variant="primary"
                        onClick={() => {
                            void api
                                .call(apiRoutes.signout, {})
                                .then(() => leaveSignedInArea(queryClient, router, WEBSITE_ACCESS_PATH));
                        }}
                    >
                        {m.website_access_sign_out()}
                    </Button>
                </div>
            </Titled>
        );
    }
    if (!allowed || problemCode(link.error) === 'forbidden') {
        return (
            <Titled title={m.website_access_forbidden_title()}>
                <p>{m.website_access_forbidden_body({ org })}</p>
            </Titled>
        );
    }
    if (problemCode(link.error) === 'website-link-conflict') {
        return (
            <Titled title={m.website_access_conflict_title()}>
                <p>{m.website_access_conflict_body()}</p>
            </Titled>
        );
    }
    if (link.isError) {
        return (
            <Titled title={m.website_access_title()}>
                <Banner tone="danger">{m.website_access_failed_link()}</Banner>
                <div>
                    <Button
                        variant="primary"
                        onClick={() => {
                            link.mutate();
                        }}
                    >
                        {m.website_access_try_link()}
                    </Button>
                </div>
            </Titled>
        );
    }
    if (link.isSuccess) {
        return (
            <EmptyState
                icon={<BadgeCheck aria-hidden />}
                title={m.website_access_done_title()}
                description={m.website_access_done_body({ org, email: pending.email })}
                headingLevel={1}
                action={
                    <ButtonLink to="/license" variant="primary">
                        {m.website_access_done_action()}
                    </ButtonLink>
                }
            />
        );
    }
    return (
        <Titled title={m.website_access_title()}>
            <p role="status">{m.website_access_linking()}</p>
        </Titled>
    );
}

/** Signed out: an existing account signs in with its passkey; a new one gets the App's own confirmation email. */
function SignedOut(props: { readonly pending: WebsitePendingView }) {
    const { storage } = useBrowser();
    const { pending } = props;
    useEffect(() => {
        rememberWebsiteLink(storage, pending.expiresAt);
    }, [storage, pending.expiresAt]);
    if (pending.accountExists) {
        return (
            <Titled title={m.website_access_title()}>
                <p>{m.website_access_signin_body({ email: pending.email })}</p>
                <div>
                    <ButtonLink to="/continue" search={{ returnTo: WEBSITE_ACCESS_PATH }} variant="primary">
                        {m.website_access_signin_action()}
                    </ButtonLink>
                </div>
            </Titled>
        );
    }
    return (
        <EmailStep
            purpose="continue"
            title={m.website_access_signup_title()}
            intro={<p>{m.website_access_signup_body({ email: pending.email })}</p>}
            submitLabel={m.website_access_signup_action()}
            presetEmail={pending.email}
            footer={null}
        />
    );
}

/**
 * `/website-access`, where the handoff lands (ADR 0021). ptbk.io has proven a mailbox for this browser, nothing more:
 * the App's own sign-in or sign-up comes first, and only then is the active organization linked.
 */
export function WebsiteAccessPage(props: { readonly error: WebsiteAccessError | undefined }) {
    const api = useApiClient();
    const session = useQuery(sessionQuery(api));
    const pending = useQuery(websitePendingQuery(api));
    if (pending.isPending || session.isPending) {
        return (
            <div>
                <span className="sr-only">{m.loading()}</span>
                <Skeleton className="h-24 w-full" />
            </div>
        );
    }
    if (pending.isError || pending.data === null) {
        return <Ended error={props.error ?? 'expired'} />;
    }
    return session.data === null || session.data === undefined ? (
        <SignedOut pending={pending.data} />
    ) : (
        <SignedIn session={session.data} pending={pending.data} />
    );
}
