import { BrandRobot, EmptyState, ErrorState, Skeleton } from '@ptbk/ui';
import { useQueryErrorResetBoundary } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { useEffect } from 'react';

import { m } from '../../paraglide/messages';
import { ApiError } from '../api/queries';
import { Link } from './link';

/** The router's error component: a retry that clears the query error boundary and reloads the route. */
export function RouteError({ error, reset }: ErrorComponentProps) {
    const router = useRouter();
    const queryErrorResetBoundary = useQueryErrorResetBoundary();
    useEffect(() => {
        queryErrorResetBoundary.reset();
    }, [queryErrorResetBoundary]);
    const unreachable = error instanceof ApiError && error.outcome.kind === 'network-error';
    return (
        <div className="py-8">
            <h1 className="sr-only">{m.error_title()}</h1>
            <ErrorState
                title={m.error_title()}
                illustration={<BrandRobot pose="resting" size="md" />}
                message={unreachable ? m.api_error_unreachable() : m.error_body()}
                onRetry={() => {
                    reset();
                    void router.invalidate();
                }}
            />
        </div>
    );
}

/** The root's error boundary: no layout could load, so the error gets the whole page. */
export function RootError(props: ErrorComponentProps) {
    return (
        <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-4">
            <RouteError {...props} />
        </main>
    );
}

/** Shaped like a page (title, a card of rows), so content replaces it without shifting the layout. */
export function RoutePending() {
    return (
        <div aria-busy="true" className="flex flex-col gap-6 py-2">
            <span className="sr-only" role="status">
                {m.loading()}
            </span>
            <Skeleton shape="text" className="h-8 w-48" />
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
                illustration={<BrandRobot pose="thinking" size="md" />}
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
