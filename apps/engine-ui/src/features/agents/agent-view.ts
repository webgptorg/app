import { canUseViewTransitions } from '@ptbk/ui';
import type { PreferenceStorage } from '@ptbk/ui';
import { flushSync } from 'react-dom';

/** How the agents page lists them: cards (the default) or the table. */
export const AGENT_VIEWS = ['grid', 'table'] as const;
export type AgentView = (typeof AGENT_VIEWS)[number];

export const AGENT_VIEW_STORAGE_KEY = 'ptbk.agents.view';

function isAgentView(value: string | null | undefined): value is AgentView {
    return AGENT_VIEWS.some((view) => view === value);
}

/** The URL's choice wins, so a shared link shows what its sender saw; else the member's last choice on this device. */
export function resolveAgentView(param: AgentView | undefined, storage: PreferenceStorage | undefined): AgentView {
    if (param !== undefined) return param;
    let stored: string | null = null;
    try {
        stored = storage?.getItem(AGENT_VIEW_STORAGE_KEY) ?? null;
    } catch {
        // A browser that refuses storage simply has no remembered choice.
    }
    return isAgentView(stored) ? stored : 'grid';
}

export function rememberAgentView(view: AgentView, storage: PreferenceStorage | undefined): void {
    try {
        storage?.setItem(AGENT_VIEW_STORAGE_KEY, view);
    } catch {
        // Not remembered; the URL still carries it.
    }
}

interface TransitionDocument {
    startViewTransition?: (update: () => void) => {
        readonly ready: Promise<unknown>;
        readonly finished: Promise<unknown>;
    };
}

/**
 * Applies a state change inside a View Transition, committed synchronously so the transition captures the new state:
 * the card and the panel share names, so one morphs into the other. Without support or with reduced motion it simply
 * applies the change.
 */
export function morph(update: () => void, doc: TransitionDocument = document): void {
    if (doc.startViewTransition === undefined || !canUseViewTransitions(doc)) {
        update();
        return;
    }
    const transition = doc.startViewTransition(() => {
        flushSync(update);
    });
    // A transition that a newer one skips rejects these; nothing waits on them, so they must not surface as errors.
    transition.ready.catch(() => undefined);
    transition.finished.catch(() => undefined);
}
