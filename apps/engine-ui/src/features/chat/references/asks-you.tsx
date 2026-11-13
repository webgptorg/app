import { MessageCircleQuestion } from 'lucide-react';

import { m } from '../../../paraglide/messages';

/** `+@User` in an agent's text: an inline "asks you" marker where the question starts. */
export function AsksYou() {
    return (
        <span className="inline-flex items-center gap-1 rounded-pill bg-accent-soft px-1.5 py-px align-[0.05em] text-xs font-medium text-accent-text">
            <MessageCircleQuestion aria-hidden className="size-3.5" />
            {m.chat_ref_asks_you()}
        </span>
    );
}
