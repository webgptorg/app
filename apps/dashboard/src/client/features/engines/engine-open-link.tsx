import { buttonClassName } from '@ptbk/ui';
import type { ButtonSize, ButtonVariant } from '@ptbk/ui';
import { ExternalLink } from 'lucide-react';

import { m } from '../../../paraglide/messages';
import { shortEngineId } from './engine-labels';

/**
 * The only reference to an engine hostname our pages may contain: a top-level link the person follows. It is built from
 * the stored hostname, never from input, opens without an opener or referrer, and nothing on our side ever fetches,
 * frames or prefetches it (the router's intent preloading applies to router links only).
 */
export function EngineOpenLink(props: {
    readonly engineId: string;
    readonly hostname: string;
    readonly variant?: ButtonVariant;
    readonly size?: ButtonSize;
    /** "Open engine" instead of "Open", where the page is not already about that engine. */
    readonly prominent?: boolean;
}) {
    return (
        <a
            href={`https://${props.hostname}/`}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            className={buttonClassName(props.variant ?? 'secondary', props.size ?? 'sm')}
        >
            <ExternalLink aria-hidden className="size-4" />
            {props.prominent === true ? m.link_progress_open() : m.engines_open()}{' '}
            <span className="sr-only">
                {props.prominent === true
                    ? m.link_progress_open_new_tab({ shortId: shortEngineId(props.engineId) })
                    : m.engines_open_new_tab({ shortId: shortEngineId(props.engineId) })}
            </span>
        </a>
    );
}
