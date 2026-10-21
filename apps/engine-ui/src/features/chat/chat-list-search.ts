import { ChatSource } from '@ptbk/engine-api';
import { z } from 'zod';

import type { ChatListParams } from './chat-keys';

/**
 * The chat list's state in the URL, so a filtered page can be linked. A bad value falls back instead of throwing;
 * cursors are opaque but always URL-safe base64 from the engine.
 */
export const ChatListSearch = z.object({
    source: ChatSource.optional().catch(undefined),
    cursor: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,1024}$/)
        .optional()
        .catch(undefined),
});
export type ChatListSearch = z.output<typeof ChatListSearch>;

export function chatListParams(search: ChatListSearch): ChatListParams {
    return {
        ...(search.source === undefined ? {} : { source: search.source }),
        ...(search.cursor === undefined ? {} : { cursor: search.cursor }),
    };
}
