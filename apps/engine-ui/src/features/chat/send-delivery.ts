import type { ChatId, EngineApiClient, MemberId, ProblemDetails } from '@ptbk/engine-api';

import { MESSAGE_PAGE_SIZE } from './chat-queries';
import type { MessagePage } from './chat-cache';

/** A slow engine may still be saving the message when the connection drops, so a first miss is not yet an answer. */
export const DELIVERY_SETTLE_MS = 1_500;

/** A 4xx is the engine declining the message. A 5xx may come from a proxy, or after the engine saved it. */
export function isRefusal(problem: ProblemDetails): boolean {
    return problem.status < 500;
}

export interface UnclearSend {
    readonly content: string;
    readonly memberId: MemberId;
    /** What the chat held before this send; the same words already there are an earlier message. */
    readonly knownIds: ReadonlySet<string>;
}

export type DeliveryCheck =
    | { readonly kind: 'arrived'; readonly page: MessagePage }
    /** `page` is `null` when the chat itself is gone. */
    | { readonly kind: 'missing'; readonly page: MessagePage | null }
    | { readonly kind: 'unknown' };

function pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

/**
 * Whether a send with no clear answer reached the chat. The contract has no idempotency key, so this looks for the
 * words among the member's new messages; the same words sent from another tab in the same moment would count.
 */
export async function checkDelivery(
    engineApi: EngineApiClient,
    chatId: ChatId,
    sent: UnclearSend,
    signal: AbortSignal,
): Promise<DeliveryCheck> {
    const look = async (): Promise<DeliveryCheck> => {
        try {
            const response = await engineApi.chats.listMessages(chatId, { limit: MESSAGE_PAGE_SIZE }, signal);
            if (response.kind === 'problem') {
                return response.problem.status === 404 ? { kind: 'missing', page: null } : { kind: 'unknown' };
            }
            const arrived = response.data.items.some(
                (item) =>
                    item.role === 'user' &&
                    item.createdBy === sent.memberId &&
                    item.content === sent.content &&
                    !sent.knownIds.has(item.id),
            );
            return { kind: arrived ? 'arrived' : 'missing', page: response.data };
        } catch {
            return { kind: 'unknown' };
        }
    };
    const first = await look();
    if (first.kind !== 'missing' || first.page === null) return first;
    await pause(DELIVERY_SETTLE_MS, signal);
    return look();
}
