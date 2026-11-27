import type { AgentOrigin, ReadAgent, ReadChat } from '@ptbk/engine-api';
import { createContext, use } from 'react';
import type { ReactNode } from 'react';

import { agentColor } from './agent-color';
import { createReferenceIndex } from './parse-references';
import type { ReferenceIndex } from './parse-references';

export type ReadChatTask = ReadChat['tasks'][number];
export type ReadChatWorking = ReadChat['working'][number];

/** An agent a thread can mention: a member, or one of the project's agents. All text in it is untrusted. */
export interface ReferenceAgent {
    /** Its `AgentId`, as the thread's participant key. */
    readonly key: string;
    readonly name: string;
    /** For `--tint`: see `agentColor`. */
    readonly color: string;
    readonly avatarUrl: string | null;
    /** `profile.description`, its one-line role; `null` until the project's agents have loaded. */
    readonly description: string | null;
    readonly profileColor: string | null;
    /** The engine's illustration ID; with `origin`, what the avatar resolves its character from. */
    readonly illustration: string | null;
    /** `undefined` until the project's agents have loaded. */
    readonly origin: AgentOrigin | undefined;
    /** It is a member of this thread, not only an agent of the project. */
    readonly member: boolean;
}

/** What chips and hovercards in a thread read, so message rows need no props for it. */
export interface ThreadReferences {
    readonly index: ReferenceIndex;
    /** By key, members first. */
    readonly agents: ReadonlyMap<string, ReferenceAgent>;
    /** By name, as `{name}` in text and a `linked` entry refer to it. */
    readonly tasks: ReadonlyMap<string, ReadChatTask>;
    readonly working: readonly ReadChatWorking[];
    /** The engine offers `tasks@1` and the member may read tasks, so "Open task" leads somewhere. */
    readonly canOpenTasks: boolean;
    /** The member may open agents, so their references carry the agent's card. */
    readonly canOpenAgents: boolean;
    /** Addresses the agent in the composer; absent where the member cannot write. */
    readonly onMention?: ((agent: ReferenceAgent) => void) | undefined;
}

const ThreadReferencesContext = createContext<ThreadReferences | null>(null);

export function ThreadReferencesProvider({
    value,
    children,
}: {
    readonly value: ThreadReferences;
    readonly children: ReactNode;
}) {
    return <ThreadReferencesContext value={value}>{children}</ThreadReferencesContext>;
}

/** `null` outside a thread (e.g. markdown elsewhere in the app): references then render as the text they are. */
export function useThreadReferences(): ThreadReferences | null {
    return use(ThreadReferencesContext);
}

/** An agent as the thread knows it, with its colour; one it does not know yet keeps the given name and a hashed hue. */
export function useReferenceAgent(key: string, fallbackName: string): ReferenceAgent {
    return (
        useThreadReferences()?.agents.get(key) ?? {
            key,
            name: fallbackName,
            color: agentColor(null, key),
            avatarUrl: null,
            description: null,
            profileColor: null,
            illustration: null,
            origin: undefined,
            member: false,
        }
    );
}

export interface ThreadReferencesInput {
    readonly chat: Pick<ReadChat, 'members' | 'tasks' | 'working'>;
    /** The project's agents, when they have loaded; `[]` without `agents.read`. */
    readonly agents: readonly ReadAgent[];
    readonly canOpenTasks: boolean;
    readonly canOpenAgents: boolean;
    readonly onMention?: ((agent: ReferenceAgent) => void) | undefined;
}

/** Members come first, so a member's name in the thread wins over a project agent with the same name. */
export function buildThreadReferences({
    chat,
    agents,
    canOpenTasks,
    canOpenAgents,
    onMention,
}: ThreadReferencesInput): ThreadReferences {
    const profiles = new Map(agents.map((agent) => [agent.id as string, agent]));
    const byKey = new Map<string, ReferenceAgent>();
    const add = (key: string, name: string, member: boolean) => {
        if (byKey.has(key)) return;
        const agent = profiles.get(key);
        const profileColor = agent?.profile.color ?? null;
        byKey.set(key, {
            key,
            name,
            color: agentColor(profileColor, key),
            avatarUrl: agent?.profile.avatarUrl ?? null,
            description: agent === undefined ? null : agent.profile.description.trim() || null,
            profileColor,
            illustration: agent?.profile.illustration ?? null,
            origin: agent?.origin,
            member,
        });
    };
    for (const member of chat.members) if (member.kind === 'agent') add(member.key, member.name, true);
    for (const agent of agents) add(agent.id, agent.name, false);
    const list = [...byKey.values()];
    return {
        index: createReferenceIndex(
            list,
            chat.tasks.map((task) => task.name),
        ),
        agents: byKey,
        tasks: new Map(chat.tasks.map((task) => [task.name, task])),
        working: chat.working,
        canOpenTasks,
        canOpenAgents,
        onMention,
    };
}
