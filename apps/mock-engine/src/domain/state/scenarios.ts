import { z } from 'zod';

export const SCENARIOS = ['empty', 'small-team', 'large-fleet'] as const;
export const Scenario = z.enum(SCENARIOS);
export type Scenario = z.infer<typeof Scenario>;

type Range = readonly [min: number, max: number];

/** How much of everything a scenario seeds; the owner always exists, so member counts exclude them. */
export interface ScenarioSize {
    readonly admins: number;
    readonly members: number;
    readonly viewers: number;
    readonly folders: number;
    /** Including the hostile demo agent when `hostileAgent` is set. */
    readonly agents: number;
    readonly hostileAgent: boolean;
    readonly chatsPerAgent: Range;
    readonly messagesPerChat: Range;
    /** Chats public visitors started, per agent that is public or unlisted, on top of `chatsPerAgent`. */
    readonly visitorChatsPerAgent: Range;
    /** Chats long enough to page through, on top of `chatsPerAgent`. */
    readonly longChats: number;
    readonly longChatMessages: Range;
    readonly secrets: number;
    /** At least two, so `last-passkey` can be exercised without revoking the only one. */
    readonly ownerPasskeys: number;
    /** Earlier sign-ins of other members; the gateway's own sessions come on top. */
    readonly otherSessions: number;
}

export const SCENARIO_SIZES: Readonly<Record<Scenario, ScenarioSize>> = {
    empty: {
        admins: 0,
        members: 0,
        viewers: 0,
        folders: 0,
        agents: 0,
        hostileAgent: false,
        chatsPerAgent: [0, 0],
        messagesPerChat: [0, 0],
        visitorChatsPerAgent: [0, 0],
        longChats: 0,
        longChatMessages: [0, 0],
        secrets: 0,
        ownerPasskeys: 1,
        otherSessions: 0,
    },
    'small-team': {
        admins: 1,
        members: 2,
        viewers: 1,
        folders: 2,
        agents: 8,
        hostileAgent: true,
        chatsPerAgent: [1, 3],
        messagesPerChat: [4, 20],
        visitorChatsPerAgent: [1, 2],
        longChats: 0,
        longChatMessages: [0, 0],
        secrets: 5,
        ownerPasskeys: 2,
        otherSessions: 3,
    },
    'large-fleet': {
        admins: 4,
        members: 30,
        viewers: 5,
        folders: 12,
        agents: 500,
        hostileAgent: true,
        chatsPerAgent: [0, 2],
        messagesPerChat: [2, 8],
        visitorChatsPerAgent: [0, 1],
        longChats: 5,
        longChatMessages: [160, 220],
        secrets: 40,
        ownerPasskeys: 2,
        otherSessions: 20,
    },
};
