import type { ReadChat, ReadChatEntry } from '@ptbk/engine-api';

import { parseFlattenedSteps } from '../chat/progress-fallback';
import { plainText } from './question-text';

/** What a recent chat's row says under its title. */
export type ChatPreview = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'working' } | null;

/** A collapsed preview of an agent's steps ("- thinking: … - mcp__mail__search …") read back into lines. */
function looksLikeSteps(preview: string): boolean {
    return parseFlattenedSteps(preview.replace(/ (?=- )/g, '\n')) !== null;
}

/** The newest finished message that is a person's or an agent's words, not a turn's progress or its steps. */
function newestWords(entries: readonly ReadChatEntry[]): string | null {
    for (const entry of entries) {
        if (entry.type !== 'message' || entry.status !== 'completed' || entry.phase === 'progress') continue;
        if (entry.content.trim() === '' || parseFlattenedSteps(entry.content) !== null) continue;
        return entry.content;
    }
    return null;
}

/**
 * A row's preview never shows an agent's progress or tool steps: the newest real message from the thread's cached
 * entries when the member has opened it, else the engine's preview unless it reads as steps, which shows as "Working…".
 * Untrusted text either way, rendered as a text node.
 */
export function chatPreview(
    chat: Pick<ReadChat, 'preview'>,
    cachedEntries: readonly ReadChatEntry[] | undefined,
): ChatPreview {
    const words = cachedEntries === undefined ? null : newestWords(cachedEntries);
    if (words !== null) return { kind: 'text', text: plainText(words) };
    if (chat.preview === null || chat.preview.trim() === '') return null;
    if (looksLikeSteps(chat.preview)) return { kind: 'working' };
    return { kind: 'text', text: plainText(chat.preview) };
}
