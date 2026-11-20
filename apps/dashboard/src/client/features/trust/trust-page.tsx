import { SkipLink } from '@ptbk/ui';

import { m } from '../../../paraglide/messages';
import { PublicFooter, PublicHeader } from '../shell/public-frame';
import { TrustPath } from './trust-path';
import { TrustCan, TrustCannot, TrustCheck } from './trust-promises';

const MAIN_ID = 'main-content';

/**
 * `/trust`: public, signed in or not, so the link from any screen and from the sign-up page lands on the same page. It
 * is the precise version of what the other screens only hint at, so they can stay with plain next steps (DASH-14);
 * short enough to take in at a glance, with every claim held to the spec.
 */
export function TrustPage() {
    return (
        <div className="flex min-h-dvh flex-col bg-surface text-text">
            <SkipLink targetId={MAIN_ID} />
            <PublicHeader width="wide" />
            <main
                id={MAIN_ID}
                tabIndex={-1}
                className="mx-auto flex w-full max-w-5xl flex-col gap-12 px-4 pt-8 pb-12 outline-none sm:pt-12 md:gap-16"
            >
                <header className="flex max-w-2xl flex-col gap-3">
                    <h1 className="text-3xl font-semibold tracking-display">{m.trust_title()}</h1>
                    <p className="text-lg sm:text-xl">{m.trust_promise()}</p>
                </header>
                <TrustPath />
                <TrustCannot />
                <TrustCan />
                <TrustCheck />
            </main>
            <PublicFooter width="wide" />
        </div>
    );
}
