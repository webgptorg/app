import { ShieldCheck } from 'lucide-react';

import { m } from '../../../paraglide/messages';
import { Link } from '../../core/link';

/**
 * The one quiet way into the security explanation on a signed-in screen. It opens `/trust` in a new tab: the link flow
 * shows its install command only once, and leaving the page would lose it.
 */
export function TrustLink() {
    return (
        <Link
            to="/trust"
            target="_blank"
            rel="noopener"
            variant="standalone"
            className="inline-flex items-center gap-1.5 self-start text-sm"
        >
            <ShieldCheck aria-hidden className="size-4" />
            {m.trust_link()}
            <span className="sr-only">{m.trust_link_new_tab()}</span>
        </Link>
    );
}
