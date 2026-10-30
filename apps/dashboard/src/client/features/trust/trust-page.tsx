import { SkipLink } from '@ptbk/ui';

import { m } from '../../../paraglide/messages';
import { PublicFooter, PublicHeader } from '../shell/public-frame';
import { TrustExplanation } from './trust-explanation';

const MAIN_ID = 'main-content';

/** `/trust`: public, signed in or not, so the link from any screen and from the sign-up page lands on the same text. */
export function TrustPage() {
    return (
        <div className="flex min-h-dvh flex-col bg-surface text-text">
            <SkipLink targetId={MAIN_ID} />
            <PublicHeader width="narrow" />
            <main
                id={MAIN_ID}
                tabIndex={-1}
                className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 outline-none"
            >
                <h1 className="font-display text-2xl font-semibold">{m.trust_title()}</h1>
                <TrustExplanation headingLevel={2} />
            </main>
            <PublicFooter width="narrow" />
        </div>
    );
}
