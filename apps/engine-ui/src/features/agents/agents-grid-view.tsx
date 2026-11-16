import type { Agent, AgentId } from '@ptbk/engine-api';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ReactNode } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { NO_ACTIVITY, useAgentActivity } from './agent-activity';
import { AgentPanel } from './agent-panel';
import { morph } from './agent-view';
import { AgentsGrid } from './agents-grid';
import { agentDetailQueryOptions } from './agents-queries';

export interface AgentsGridViewProps {
    readonly own: readonly Agent[];
    readonly builtIn: readonly Agent[];
    readonly showOwn: boolean;
    readonly loading: boolean;
    /** The agent whose panel the URL keeps open. */
    readonly openId: AgentId | null;
    /** Writes the open panel to the URL; `undefined` closes it. */
    readonly onOpenChange: (agentId: AgentId | undefined) => void;
    readonly pager: ReactNode;
    readonly empty: ReactNode;
}

/**
 * The cards and the panel over them. The panel's state is local first, set inside a View Transition so the card
 * morphs into it, then written to the URL; a URL change from elsewhere (Back, a shared link) follows the same way.
 */
export function AgentsGridView({
    own,
    builtIn,
    showOwn,
    loading,
    openId,
    onOpenChange,
    pager,
    empty,
}: AgentsGridViewProps) {
    const activity = useAgentActivity();
    const [shownId, setShownId] = useState<AgentId | null>(openId);
    const [morphId, setMorphId] = useState<AgentId | null>(openId);
    // Where the panel is headed, set before the URL follows, so the URL catching up starts no second transition (a
    // second one would skip the first, and the card would never morph).
    const intended = useRef(openId);
    useEffect(() => {
        if (openId === intended.current) return;
        const target = openId ?? intended.current;
        intended.current = openId;
        // Not flushed (this is an effect): the transition captures its old state after this commit.
        if (target !== null) setMorphId(target);
        morph(() => {
            setShownId(openId);
        });
    }, [openId]);

    const listed = [...own, ...builtIn].find((agent) => agent.id === shownId);
    // A shared link may name an agent beyond this page or filter; the panel then reads it on its own.
    const fetched = useQuery({
        ...agentDetailQueryOptions(useEngineApi(), shownId ?? ('' as AgentId)),
        enabled: shownId !== null && listed === undefined,
    });
    const shown = listed ?? (shownId === null ? undefined : fetched.data);

    const open = (agent: Agent) => {
        intended.current = agent.id;
        // Named first, outside the transition, so the old snapshot holds this card and no other.
        flushSync(() => {
            setMorphId(agent.id);
        });
        morph(() => {
            setShownId(agent.id);
        });
        onOpenChange(agent.id);
    };
    const close = () => {
        intended.current = null;
        morph(() => {
            setShownId(null);
        });
        onOpenChange(undefined);
    };

    return (
        <>
            <AgentsGrid
                own={own}
                builtIn={builtIn}
                showOwn={showOwn}
                loading={loading}
                activity={activity}
                openId={shown === undefined ? null : shown.id}
                morphId={morphId}
                onOpen={open}
                pager={pager}
                empty={empty}
            />
            {shown === undefined || shown.deletedAt !== null ? null : (
                <AgentPanel
                    key={shown.id}
                    agent={shown}
                    activity={activity.get(shown.id) ?? NO_ACTIVITY}
                    onClose={close}
                />
            )}
        </>
    );
}
