import { TrustMark } from '@ptbk/ui';

import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';

/**
 * The trust mark in the shell, derived from the engine ID only. It opens the security page, where U-06 shows the
 * trust panel; the same mark appears in the dashboard's engine list, so users can compare the two.
 */
export function ShellTrustMark({ showCode = false }: { readonly showCode?: boolean }) {
    return (
        <Link
            to="/security"
            variant="standalone"
            className="inline-flex items-center gap-2 rounded-control p-1 no-underline hover:bg-hover"
        >
            <span className="sr-only">{m.trust_mark_open()}</span>
            <TrustMark engineId={null} state="verified" size="sm" showCode={showCode} />
        </Link>
    );
}
