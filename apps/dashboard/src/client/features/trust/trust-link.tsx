import { Dialog } from '@ptbk/ui';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';

import { m } from '../../../paraglide/messages';
import { TrustExplanation } from './trust-explanation';

/**
 * The one quiet way into the security explanation on a signed-in screen. A dialog, not a page: the link flow shows its
 * install command only once, and leaving the page would lose it.
 */
export function TrustLink() {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button
                type="button"
                className="inline-flex cursor-pointer items-center gap-1.5 self-start rounded-small text-sm text-(--anchor-text) hover:text-(--anchor-text-hover) hover:underline"
                onClick={() => {
                    setOpen(true);
                }}
            >
                <ShieldCheck aria-hidden className="size-4" />
                {m.trust_link()}
            </button>
            <Dialog
                open={open}
                onClose={() => {
                    setOpen(false);
                }}
                title={m.trust_title()}
                size="lg"
            >
                <TrustExplanation headingLevel={3} />
            </Dialog>
        </>
    );
}
