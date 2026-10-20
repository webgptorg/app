import { useQueryErrorResetBoundary } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

// Placeholders until U-02 replaces them with @ptbk/ui components and translated text. No palette colours here:
// feature code uses only semantic tokens (ADR 0015), which U-02 defines.

export function RouteError() {
    const router = useRouter();
    const queryErrorResetBoundary = useQueryErrorResetBoundary();
    useEffect(() => {
        queryErrorResetBoundary.reset();
    }, [queryErrorResetBoundary]);
    return (
        <section role="alert" className="space-y-4">
            <h1 className="text-2xl font-semibold">Something went wrong</h1>
            <button type="button" className="rounded border px-3 py-1.5" onClick={() => void router.invalidate()}>
                Try again
            </button>
        </section>
    );
}

export function RoutePending() {
    return <p role="status">Loading…</p>;
}

export function RouteNotFound() {
    return (
        <section className="space-y-4">
            <h1 className="text-2xl font-semibold">Not found</h1>
            <Link to="/agents" className="underline">
                Go to agents
            </Link>
        </section>
    );
}
