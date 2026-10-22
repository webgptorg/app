import type { ChatListQuery } from '@ptbk/engine-api';
import type { z } from 'zod';

import { chatKeys } from '../chat/chat-keys';

export type RecentChatParams = z.input<typeof ChatListQuery>;

export const homeKeys = {
    all: ['home'] as const,
    /** An update the engine announced as activity since `GET /security` was read; written by the event sync only. */
    updateNotice: () => [...homeKeys.all, 'update-notice'] as const,
    /** Under `chats`, so whatever refreshes chats refreshes these too. */
    recentChats: (params: RecentChatParams) => [...chatKeys.all, 'recent', params] as const,
};
