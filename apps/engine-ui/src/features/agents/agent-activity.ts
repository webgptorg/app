import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { ReadChat, ReadRun, ReadTask } from '@ptbk/engine-api';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { createContext, useContext, useMemo } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { useAllows } from '../../app/registry/use-visible-features';
import { chatListQueryOptions } from '../chat/chat-queries';
import { runListQueryOptions } from '../runs/runs-queries';
import { taskListQueryOptions } from '../tasks/tasks-queries';

/** One active-tasks page is plenty for a glance; the agent's page has the rest. */
const ACTIVE_TASK_LIMIT = 50;

export interface AgentWorking {
    readonly chat: ReadChat;
    readonly working: ReadChat['working'][number];
}

/** What one agent is doing and has recently done, from lists the app already reads. */
export interface AgentActivity {
    /** Replies it is writing now, newest first. */
    readonly working: readonly AgentWorking[];
    /** Threads it is a member of, newest first. */
    readonly chats: readonly ReadChat[];
    /** Tasks it is running now. */
    readonly tasks: readonly ReadTask[];
    /** Runs of it running now. */
    readonly runs: readonly ReadRun[];
    /** The newest message in any of its threads, or `null` when there is none in view. */
    readonly lastActiveAt: string | null;
}

export const NO_ACTIVITY: AgentActivity = { working: [], chats: [], tasks: [], runs: [], lastActiveAt: null };

interface Sources {
    readonly chats: readonly ReadChat[];
    readonly tasks: readonly ReadTask[];
    readonly runs: readonly ReadRun[];
}

function newer(a: string | null, b: string | null): string | null {
    if (a === null) return b;
    if (b === null) return a;
    return a > b ? a : b;
}

/** Groups the three lists by agent, so every card and the panel read from one map instead of asking for their own. */
export function groupActivity({ chats, tasks, runs }: Sources): ReadonlyMap<string, AgentActivity> {
    const byAgent = new Map<
        string,
        { working: AgentWorking[]; chats: ReadChat[]; tasks: ReadTask[]; runs: ReadRun[]; lastActiveAt: string | null }
    >();
    const entry = (agentId: string) => {
        let found = byAgent.get(agentId);
        if (found === undefined) {
            found = { working: [], chats: [], tasks: [], runs: [], lastActiveAt: null };
            byAgent.set(agentId, found);
        }
        return found;
    };
    for (const chat of chats) {
        for (const member of chat.members) {
            if (member.kind !== 'agent') continue;
            const activity = entry(member.key);
            activity.chats.push(chat);
            activity.lastActiveAt = newer(activity.lastActiveAt, chat.lastMessageAt);
        }
        for (const working of chat.working) {
            if (working.author.kind === 'agent') entry(working.author.key).working.push({ chat, working });
        }
    }
    for (const task of tasks) {
        if (task.agentId !== null) entry(task.agentId).tasks.push(task);
    }
    for (const run of runs) entry(run.agentId).runs.push(run);
    return byAgent;
}

/**
 * Every agent's live work in three requests: recent threads, running tasks and running runs, each only where the
 * member may read it and the engine offers it. Event sync keeps all three current, so nothing here polls.
 */
export function useAgentActivity(): ReadonlyMap<string, AgentActivity> {
    const engineApi = useEngineApi();
    const chatsAllowed = useAllows({ permission: 'chats.read' });
    const tasksAllowed = useAllows({ capability: KNOWN_CAPABILITIES.tasks, permission: 'tasks.read' });
    const runsAllowed = useAllows({ capability: KNOWN_CAPABILITIES.runs, permission: 'runs.read' });
    const chats = useQuery({ ...chatListQueryOptions(engineApi, {}), enabled: chatsAllowed });
    const tasks = useInfiniteQuery({
        ...taskListQueryOptions(engineApi, { limit: ACTIVE_TASK_LIMIT, state: 'active' }),
        enabled: tasksAllowed,
    });
    const runs = useQuery({ ...runListQueryOptions(engineApi, { status: 'running' }), enabled: runsAllowed });
    const chatItems = chatsAllowed ? chats.data?.items : undefined;
    const taskItems = tasksAllowed ? tasks.data?.pages[0]?.items : undefined;
    const runItems = runsAllowed ? runs.data?.items : undefined;
    return useMemo(
        () => groupActivity({ chats: chatItems ?? [], tasks: taskItems ?? [], runs: runItems ?? [] }),
        [chatItems, taskItems, runItems],
    );
}

/** Working when it writes a reply or runs a task or a run; the card and the panel say so before anything else. */
export function isWorking(activity: AgentActivity): boolean {
    return activity.working.length > 0 || activity.tasks.length > 0 || activity.runs.length > 0;
}

/** The page's activity map, for cells deep in a table that cannot take it as a prop without rebuilding the columns. */
export const AgentActivityContext = createContext<ReadonlyMap<string, AgentActivity>>(new Map());

export function useAgentActivityOf(agentId: string): AgentActivity {
    return useContext(AgentActivityContext).get(agentId) ?? NO_ACTIVITY;
}
