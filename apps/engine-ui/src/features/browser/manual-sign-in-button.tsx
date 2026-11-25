import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { WalletSignInTarget } from '@ptbk/engine-api';
import { Button } from '@ptbk/ui';

import { useAccess } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { ComputerControlLink } from './computer-control-link';
import { signInOrigin, useOpenSignIn } from './use-browser-actions';

/** Open the selected login in the project browser, keeping the request identity through a passkey step-up. */
export function ManualSignInButton({
    origin,
    wallet,
}: {
    readonly origin: string;
    readonly wallet: WalletSignInTarget;
}) {
    const access = useAccess();
    const open = useOpenSignIn();
    const bound = access.supports(KNOWN_CAPABILITIES.walletSignIn);
    if (!access.can('browser.control')) return null;
    if ((!bound && !access.supports(KNOWN_CAPABILITIES.browserTab)) || signInOrigin(origin) === null) {
        return <ComputerControlLink />;
    }
    return (
        <Button
            size="sm"
            loading={open.isPending}
            onClick={() => {
                open.mutate(bound ? { origin, wallet } : { origin });
            }}
        >
            {m.browser_sign_in_here()}
        </Button>
    );
}
