import { ChevronRight, ShieldCheck } from 'lucide-react';

import { m } from '../../paraglide/messages';

/**
 * How the Wallet keeps passwords, for whoever wonders: one quiet line that opens into a short paragraph, the way
 * technical details open elsewhere, so it reassures without competing with the logins.
 */
export function WalletTrust() {
    return (
        <details className="group border-t border-hairline pt-4 text-sm">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-small text-text-muted hover:text-text [&::-webkit-details-marker]:hidden">
                <ShieldCheck aria-hidden className="size-4 shrink-0" />
                {m.wallet_trust_summary()}
                <ChevronRight
                    aria-hidden
                    className="size-4 shrink-0 motion-safe:transition-transform motion-safe:duration-(--motion-state) group-open:rotate-90"
                />
            </summary>
            <p className="mt-2 max-w-prose ps-5.5 text-text-muted">{m.wallet_trust_body()}</p>
        </details>
    );
}
