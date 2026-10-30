import { Card, SkipLink } from '@ptbk/ui';
import { Outlet } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { PublicFooter, PublicHeader } from '../shell/public-frame';

const MAIN_ID = 'main-content';

/** The signed-out frame around sign-in, sign-up and recovery: the brand, language and theme, one card. */
export function AuthLayout() {
    return (
        <AuthFrame>
            <Outlet />
        </AuthFrame>
    );
}

/** The frame on its own, for a signed-out visitor outside the `_auth` layout (not found). */
export function AuthFrame({ children }: { readonly children: ReactNode }) {
    return (
        <div className="flex min-h-dvh flex-col bg-surface text-text">
            <SkipLink targetId={MAIN_ID} />
            <PublicHeader width="wide" />
            <main
                id={MAIN_ID}
                tabIndex={-1}
                className="flex flex-1 items-start justify-center px-4 py-8 outline-none md:py-16"
            >
                <Card as="div" className="w-full max-w-md">
                    {children}
                </Card>
            </main>
            <PublicFooter width="wide" />
        </div>
    );
}
