import { Button, EmptyState, ErrorState, Skeleton } from '@ptbk/ui';
import { useQueryErrorResetBoundary } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { Compass, LockKeyhole, SearchX } from 'lucide-react';
import { useEffect } from 'react';
import type { ReactNode } from 'react';

import { useStepUp } from '../features/step-up/step-up';
import { m } from '../paraglide/messages';
import { AccessDeniedError } from './access-denied';
import { classifyApiError } from './api-errors';
import { Link } from './link';

/**
 * The router's error component: an access decision or a refusal by the engine reads as an explanation, anything else
 * as an error with a retry that clears the query error boundary and reloads the route.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
    const router = useRouter();
    const queryErrorResetBoundary = useQueryErrorResetBoundary();
    const stepUp = useStepUp();
    useEffect(() => {
        queryErrorResetBoundary.reset();
    }, [queryErrorResetBoundary]);

    if (error instanceof AccessDeniedError) {
        return error.reason === 'unavailable' ? (
            <RouteMessage
                icon={<Compass aria-hidden />}
                title={m.access_unavailable_title()}
                description={m.access_unavailable_body()}
            />
        ) : (
            <RouteMessage
                icon={<LockKeyhole aria-hidden />}
                title={m.access_denied_title()}
                description={m.access_denied_body()}
            />
        );
    }

    const failure = classifyApiError(error);
    if (failure.kind === 'problem' && failure.problem.code === 'step-up-required') {
        return (
            <RouteMessage
                icon={<LockKeyhole aria-hidden />}
                title={m.step_up_title()}
                description={m.step_up_body()}
                action={
                    <Button variant="primary" onClick={stepUp.request}>
                        {m.step_up_continue()}
                    </Button>
                }
            />
        );
    }
    // The engine refusing a page is the same situation as the UI knowing the permission is missing: same words.
    if (failure.kind === 'problem' && failure.problem.status === 403) {
        return (
            <RouteMessage
                icon={<LockKeyhole aria-hidden />}
                title={m.access_denied_title()}
                description={m.access_denied_body()}
            />
        );
    }

    return (
        <div className="py-8">
            <h1 className="sr-only">{m.error_title()}</h1>
            <ErrorState
                title={m.error_title()}
                message={m.error_body()}
                onRetry={() => {
                    reset();
                    void router.invalidate();
                }}
            />
        </div>
    );
}

/** The root's error boundary: the shell itself could not load, so the error gets the whole page. */
export function RootError(props: ErrorComponentProps) {
    return (
        <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-4">
            <RouteError {...props} />
        </main>
    );
}

interface RouteMessageProps {
    readonly icon: ReactNode;
    readonly title: string;
    readonly description: string;
    readonly action?: ReactNode;
}

function RouteMessage({ icon, title, description, action }: RouteMessageProps) {
    return (
        <div className="py-8">
            <EmptyState icon={icon} title={title} description={description} action={action} headingLevel={1} />
        </div>
    );
}

/** Shaped like a page (title, toolbar, rows) so content replaces it without shifting the layout. */
export function RoutePending() {
    return (
        <div aria-busy="true" className="flex flex-col gap-6 py-2">
            <span className="sr-only" role="status">
                {m.loading()}
            </span>
            <Skeleton shape="text" className="h-8 w-48" />
            <Skeleton shape="block" className="h-10 w-full max-w-md" />
            <div className="flex flex-col gap-3">
                <Skeleton shape="block" className="h-12 w-full" />
                <Skeleton shape="block" className="h-12 w-full" />
                <Skeleton shape="block" className="h-12 w-full" />
            </div>
        </div>
    );
}

export function RouteNotFound() {
    return (
        <div className="py-8">
            <EmptyState
                icon={<SearchX aria-hidden />}
                title={m.not_found_title()}
                description={m.not_found_body()}
                headingLevel={1}
                action={
                    <Link to="/" variant="standalone">
                        {m.not_found_back()}
                    </Link>
                }
            />
        </div>
    );
}
