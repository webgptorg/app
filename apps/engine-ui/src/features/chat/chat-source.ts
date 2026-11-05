import type { ReadRun } from '@ptbk/engine-api';

import { m } from '../../paraglide/messages';

/** What started a run; chats no longer have a source of their own. */
export type ChatSourceLabel = ReadRun['source'];

/** A source this UI does not know yet reads as `unknown` (the client's tolerant reader), never as an error. */
export function sourceLabel(source: ChatSourceLabel): string {
    switch (source) {
        case 'web':
            return m.chat_source_web();
        case 'api':
            return m.chat_source_api();
        case 'email':
            return m.chat_source_email();
        case 'schedule':
            return m.chat_source_schedule();
        case 'member':
            return m.chat_source_member();
        case 'goal':
            return m.chat_source_goal();
        case 'webhook':
            return m.chat_source_webhook();
        case 'unknown':
            return m.chat_source_unknown();
    }
}
