import type { ReadChat } from '@ptbk/engine-api';

import { m } from '../../paraglide/messages';

/** The agents in a thread, in the order they joined; the User is implied by the member reading it. */
export function threadMembers(chat: Pick<ReadChat, 'members'>): string {
    return chat.members
        .filter((member) => member.kind !== 'user')
        .map((member) => member.name)
        .join(', ');
}

/** A thread's title, else its newest words, else "Untitled". */
export function chatName(chat: Pick<ReadChat, 'title' | 'preview'>): string {
    if (chat.title.trim() !== '') return chat.title;
    if (chat.preview !== null && chat.preview.trim() !== '') return chat.preview;
    return m.chat_untitled();
}
