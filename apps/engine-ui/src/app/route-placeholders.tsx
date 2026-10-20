import { useQueryErrorResetBoundary } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

// Placeholders until U-02 replaces them with @ptbk/ui components and translated text.

export function RouteError() {
    const router = useRouter();
    const queryErrorResetBoundary = useQueryErrorResetBoundary();
    useEffect(() => {
        queryErrorResetBoundary.reset();
    }, [queryErrorResetBoundary]);
    return (
        <section role="alert" className="space-y-4">
            <h1 className="text-2xl font-semibold">Something went wrong</h1>
            <button
                type="button"
                className="rounded bg-neutral-900 px-3 py-1.5 text-white"
                onClick={() => void router.invalidate()}
            >
                Try again
            </button>
        </section>
    );
}

export function RoutePending() {
    return (
        <p role="status" className="text-neutral-700">
            Loading…
        </p>
    );
}

export function RouteNotFound() {
    return (
        <section className="space-y-4">
            <h1 className="text-2xl font-semibold">Not found</h1>
            <Link to="/agents" className="text-blue-700 underline">
                Go to agents
            </Link>
        </section>
    );
}
