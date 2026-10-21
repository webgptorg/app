import { RUN_SOURCES } from '@ptbk/engine-api';
import type { ReadChat } from '@ptbk/engine-api';

import { m } from '../../paraglide/messages';

export type ChatSourceLabel = ReadChat['source'];

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

export function sourceFilterOptions() {
    return RUN_SOURCES.map((source) => ({ value: source, label: sourceLabel(source) }));
}

/** What a chat list row or the chat header calls the chat: its title, else its first message, else "Untitled". */
export function chatName(chat: Pick<ReadChat, 'title' | 'preview'>): string {
    if (chat.title.trim() !== '') return chat.title;
    if (chat.preview !== null && chat.preview.trim() !== '') return chat.preview;
    return m.chat_untitled();
}
