import type { AgentId, AgentSource } from '@ptbk/engine-api';
import { createContext, useContext, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';

import { UnsavedChangesGuard } from './unsaved-changes-guard';

interface Draft {
    readonly base: AgentSource;
    readonly source: string;
}

type DraftState = readonly [Draft | null, Dispatch<SetStateAction<Draft | null>>];
const DraftContext = createContext<DraftState | null>(null);

/** Both tabs edit the same text and retain the revision it came from, even after a background refetch. */
export function AgentBookDraftProvider({ agentId, children }: { agentId: AgentId; children: ReactNode }) {
    const state = useState<Draft | null>(null);
    const path = '/agents/' + encodeURIComponent(agentId);
    return (
        <DraftContext.Provider value={state}>
            <UnsavedChangesGuard
                when={state[0] !== null && state[0].source !== state[0].base.source}
                keepPaths={[path + '/book', path + '/settings']}
                onDiscard={() => {
                    state[1](null);
                }}
            />
            {children}
        </DraftContext.Provider>
    );
}

export function useAgentBookDraft(initial: AgentSource) {
    const state = useContext(DraftContext);
    if (state === null) throw new Error('An agent Book draft needs its agent page.');
    const [pending, setPending] = state;
    const base = pending?.base ?? initial;
    return {
        base,
        draft: pending?.source ?? initial.source,
        change: (source: string) => {
            setPending({ base, source });
        },
        reset: () => {
            setPending(null);
        },
        saved: (result: AgentSource, submitted: string) => {
            // Typing may continue while the engine saves, including in the other tab.
            setPending((current) =>
                current === null || current.source === submitted || current.source === result.source
                    ? null
                    : { base: result, source: current.source },
            );
        },
    };
}
