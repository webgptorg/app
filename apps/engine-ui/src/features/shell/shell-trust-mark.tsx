import { TrustMark } from '@ptbk/ui';
import { useSuspenseQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { engineInfoQueryOptions } from '../engine/engine-queries';
import { TRUST_PANEL_HASH } from '../security/trust-panel-hash';

/**
 * The trust mark in the shell, derived from the engine ID only. It opens the security page's trust panel and moves
 * focus there; the same mark appears in the dashboard's engine list, so users can compare the two.
 */
export function ShellTrustMark({ showCode = false }: { readonly showCode?: boolean }) {
    const { data: engine } = useSuspenseQuery(engineInfoQueryOptions(useEngineApi()));
    return (
        <Link
            to="/security"
            hash={TRUST_PANEL_HASH}
            variant="standalone"
            className="inline-flex items-center gap-2 rounded-control p-1 no-underline hover:bg-hover"
        >
            <span className="sr-only">{m.trust_mark_open()}</span>
            <TrustMark engineId={engine.engineId} state="verified" size="sm" showCode={showCode} />
        </Link>
    );
}
