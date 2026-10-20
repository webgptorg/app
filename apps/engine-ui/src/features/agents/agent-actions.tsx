import type { Agent, AgentVisibility } from '@ptbk/engine-api';
import { ConfirmDialog } from '@ptbk/ui';
import type { MenuEntry } from '@ptbk/ui';
import { Globe, Lock, Play, Square, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { classifyApiError } from '../../app/api-errors';
import { isForbidden, isStepUpRequired } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import { useAgentMutations } from './use-agent-mutations';
import type { AgentMutationOptions } from './use-agent-mutations';

type PendingConfirmation =
    { readonly kind: 'make-public'; readonly agent: Agent } | { readonly kind: 'delete'; readonly agent: Agent };

export interface AgentActions {
    readonly canRun: boolean;
    readonly canChangeVisibility: boolean;
    readonly canDelete: boolean;
    readonly start: (agent: Agent) => void;
    readonly stop: (agent: Agent) => void;
    readonly isChangingRunState: boolean;
    /** Making an agent public asks first: anyone with the link could then chat with it without signing in. */
    readonly changeVisibility: (agent: Agent, visibility: AgentVisibility) => void;
    readonly requestDelete: (agent: Agent) => void;
    /** The row-menu entries this member may use, by permission; an empty list hides the menu. */
    readonly menuEntries: (agent: Agent) => readonly MenuEntry[];
    /** The confirmation dialogs; render once wherever the actions are offered. */
    readonly dialogs: ReactNode;
}

/** Start, stop, visibility and delete for any agent, each offered only when `can()` allows it. */
export function useAgentActions(options: AgentMutationOptions = {}): AgentActions {
    const { can } = usePermissions();
    const mutations = useAgentMutations(options);
    const [pending, setPending] = useState<PendingConfirmation | null>(null);
    const [deleteError, setDeleteError] = useState<string | undefined>(undefined);

    const canRun = can('agents.run');
    const canChangeVisibility = can('agents.write');
    const canDelete = can('agents.delete');
    const target = (agent: Agent) => ({ id: agent.id, name: agent.name });

    const start = (agent: Agent) => {
        mutations.start.mutate(target(agent));
    };
    const stop = (agent: Agent) => {
        mutations.stop.mutate(target(agent));
    };
    const changeVisibility = (agent: Agent, visibility: AgentVisibility) => {
        if (visibility === agent.visibility) return;
        if (visibility === 'public') setPending({ kind: 'make-public', agent });
        else mutations.setVisibility.mutate({ ...target(agent), visibility });
    };
    const requestDelete = (agent: Agent) => {
        setDeleteError(undefined);
        setPending({ kind: 'delete', agent });
    };
    const close = () => {
        setPending(null);
        setDeleteError(undefined);
    };

    const menuEntries = (agent: Agent): MenuEntry[] => {
        const entries: MenuEntry[] = [];
        if (canRun) {
            entries.push(
                {
                    kind: 'item',
                    id: 'start',
                    label: m.agent_action_start(),
                    icon: <Play />,
                    onSelect: () => {
                        start(agent);
                    },
                },
                {
                    kind: 'item',
                    id: 'stop',
                    label: m.agent_action_stop(),
                    icon: <Square />,
                    onSelect: () => {
                        stop(agent);
                    },
                },
            );
        }
        if (canChangeVisibility) {
            const makePublic = agent.visibility !== 'public';
            entries.push({
                kind: 'item',
                id: makePublic ? 'make-public' : 'make-private',
                label: makePublic ? m.agent_action_make_public() : m.agent_action_make_private(),
                icon: makePublic ? <Globe /> : <Lock />,
                onSelect: () => {
                    changeVisibility(agent, makePublic ? 'public' : 'private');
                },
            });
        }
        if (canDelete) {
            if (entries.length > 0) entries.push({ kind: 'separator', id: 'danger' });
            entries.push({
                kind: 'item',
                id: 'delete',
                label: m.agent_action_delete(),
                icon: <Trash2 />,
                tone: 'danger',
                onSelect: () => {
                    requestDelete(agent);
                },
            });
        }
        return entries;
    };

    const confirmDelete = (agent: Agent) => {
        setDeleteError(undefined);
        mutations.remove.mutate(target(agent), {
            onSuccess: close,
            onError: (error) => {
                const failure = classifyApiError(error);
                // The step-up dialog explains itself; this one stays open underneath for the way back.
                if (isStepUpRequired(failure)) return;
                setDeleteError(isForbidden(failure) ? m.agent_delete_not_allowed() : m.agent_delete_failed_detail());
            },
        });
    };

    const dialogs = (
        <>
            {pending?.kind === 'make-public' ? (
                <ConfirmDialog
                    open
                    onClose={close}
                    title={m.agent_make_public_title({ name: pending.agent.name })}
                    description={m.agent_make_public_body({ name: pending.agent.name })}
                    confirmLabel={m.agent_action_make_public()}
                    onConfirm={() => {
                        mutations.setVisibility.mutate({ ...target(pending.agent), visibility: 'public' });
                        close();
                    }}
                />
            ) : null}
            {pending?.kind === 'delete' ? (
                <ConfirmDialog
                    open
                    onClose={close}
                    tone="danger"
                    title={m.agent_delete_title({ name: pending.agent.name })}
                    description={m.agent_delete_body()}
                    confirmLabel={m.agent_action_delete()}
                    confirmPhrase={pending.agent.name}
                    loading={mutations.remove.isPending}
                    {...(deleteError === undefined ? {} : { error: deleteError })}
                    onConfirm={() => {
                        confirmDelete(pending.agent);
                    }}
                />
            ) : null}
        </>
    );

    return {
        canRun,
        canChangeVisibility,
        canDelete,
        start,
        stop,
        isChangingRunState: mutations.start.isPending || mutations.stop.isPending,
        changeVisibility,
        requestDelete,
        menuEntries,
        dialogs,
    };
}
