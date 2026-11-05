import type { ProblemDetails } from '@ptbk/engine-api';

import { m } from '../../paraglide/messages';

/** A 4xx is the engine declining the message. A 5xx may come from a proxy, or after the engine saved it. */
export function isRefusal(problem: ProblemDetails): boolean {
    return problem.status < 500;
}

/** What a refused send tells the member. The composer keeps the text, so a sign-in does not happen over their head. */
export function refusalTitle(problem: ProblemDetails): string {
    if (problem.code === 'unauthenticated') return m.chat_send_signed_out();
    return problem.status === 403 ? m.error_forbidden_title() : m.chat_send_failed();
}

/**
 * A key for one message the member means to send. A send without a clear answer goes again under the same key, and
 * the engine answers the original message instead of saving it twice.
 */
export function newRequestKey(): string {
    return crypto.randomUUID();
}
