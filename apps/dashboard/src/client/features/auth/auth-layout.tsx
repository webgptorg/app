import { Card, SkipLink } from '@ptbk/ui';
import { Outlet } from '@tanstack/react-router';

import { PublicFooter, PublicHeader } from '../shell/public-frame';

const MAIN_ID = 'main-content';

/** The signed-out frame around sign-in, sign-up and recovery: the brand, language and theme, one card. */
export function AuthLayout() {
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
                    <Outlet />
                </Card>
            </main>
            <PublicFooter width="wide" />
        </div>
    );
}
