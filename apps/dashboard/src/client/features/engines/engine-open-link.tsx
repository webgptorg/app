import { buttonClassName } from '@ptbk/ui';
import { ExternalLink } from 'lucide-react';

import { m } from '../../../paraglide/messages';
import { shortEngineId } from './engine-labels';

/**
 * The only reference to an engine hostname our pages may contain: a top-level link the person follows. It is built from
 * the stored hostname, never from input, opens without an opener or referrer, and nothing on our side ever fetches,
 * frames or prefetches it (the router's intent preloading applies to router links only).
 */
export function EngineOpenLink(props: { readonly engineId: string; readonly hostname: string }) {
    return (
        <a
            href={`https://${props.hostname}/`}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            className={buttonClassName('secondary', 'sm')}
        >
            <ExternalLink aria-hidden className="size-4" />
            {m.engines_open()}{' '}
            <span className="sr-only">{m.engines_open_new_tab({ shortId: shortEngineId(props.engineId) })}</span>
        </a>
    );
}
