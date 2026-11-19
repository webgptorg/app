import { buttonClassName } from '@ptbk/ui';
import type { ButtonSize, ButtonVariant } from '@ptbk/ui';
import { ExternalLink } from 'lucide-react';

import { m } from '../../../paraglide/messages';

const LABELS = { open: m.engines_open, engine: m.link_progress_open, setup: m.engines_continue_setup } as const;
const TARGETS = {
    open: m.engines_open_new_tab,
    engine: m.link_progress_open_new_tab,
    setup: m.engines_continue_setup_new_tab,
} as const;

/**
 * The only reference to an engine hostname our pages may contain: a top-level link the person follows. It is built from
 * the stored hostname, never from input, opens without an opener or referrer, and nothing on our side ever fetches,
 * frames or prefetches it (the router's intent preloading applies to router links only).
 */
export function EngineOpenLink(props: {
    /** `engineLabel()` of the engine, for the link's accessible name. */
    readonly name: string;
    readonly hostname: string;
    readonly variant?: ButtonVariant;
    readonly size?: ButtonSize;
    /**
     * `engine`: "Open engine", where the page is not already about that engine. `setup`: "Continue setup" for an engine
     * whose setup is unfinished; the engine UI lands on setup by itself, so the address stays the same.
     */
    readonly wording?: 'open' | 'engine' | 'setup';
}) {
    const wording = props.wording ?? 'open';
    return (
        <a
            href={`https://${props.hostname}/`}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            className={buttonClassName(props.variant ?? 'secondary', props.size ?? 'sm')}
        >
            <ExternalLink aria-hidden className="size-4" />
            {LABELS[wording]()} <span className="sr-only">{TARGETS[wording]({ name: props.name })}</span>
        </a>
    );
}
