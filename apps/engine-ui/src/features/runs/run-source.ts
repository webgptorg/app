import { m } from '../../paraglide/messages';
import { sourceLabel } from '../chat/chat-source';
import type { ChatSourceLabel } from '../chat/chat-source';

/** The run as the subject of a sentence, named by what started it: "A scheduled run", "A run from a chat". */
export function runOrigin(source: ChatSourceLabel): string {
    switch (source) {
        case 'web':
            return m.run_origin_web();
        case 'api':
            return m.run_origin_api();
        case 'email':
            return m.run_origin_email();
        case 'schedule':
            return m.run_origin_schedule();
        case 'member':
            return m.run_origin_member();
        case 'goal':
            return m.run_origin_goal();
        case 'webhook':
            return m.run_origin_webhook();
        case 'unknown':
            return m.run_origin_unknown();
    }
}

/** What started a run, as a filter option or the summary line names it; a chat is "Chat", not the channel "Web". */
export function runSourceLabel(source: ChatSourceLabel): string {
    return source === 'web' ? m.run_source_web() : sourceLabel(source);
}
