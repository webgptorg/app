import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { AgentSource, Revision } from '@ptbk/engine-api';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { classifyApiError, unwrap } from '../../app/api-errors';
import type { ApiFailure } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { agentKeys } from '../agents/agents-keys';
import { agentDetailQueryOptions } from '../agents/agents-queries';
import { useAgentBookDraft } from './agent-book-draft';
import { bookKeys } from './book-keys';
import { agentSourceQueryOptions } from './book-queries';
import { useBookValidation } from './use-book-validation';

/** Saves are not cancelled by navigation, so they carry their own timeout instead of a component's signal. */
const SAVE_TIMEOUT_MS = 30_000;

function problemCode(failure: ApiFailure): string | undefined {
    return failure.kind === 'problem' ? failure.problem.code : undefined;
}

function saveFailureMessage(failure: ApiFailure): string {
    const code = problemCode(failure);
    if (code === 'revision-conflict') return m.book_save_conflict();
    if (code === 'invalid-book') return m.book_save_invalid();
    return m.book_save_failed();
}

interface Variables {
    readonly source: string;
    readonly baseRevisionId: AgentSource['revisionId'];
}

export function useBookWorkspace(initial: AgentSource) {
    const agentId = initial.agentId;
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const { data: agent } = useSuspenseQuery(agentDetailQueryOptions(engineApi, agentId));
    const hasEditor = useAllows({ capability: KNOWN_CAPABILITIES.bookEditor });
    const mayWrite = useAllows({ capability: KNOWN_CAPABILITIES.bookEditor, permission: 'agents.write' });
    const canWrite = mayWrite && agent.origin !== 'system';
    const { base, draft, change, reset, saved } = useAgentBookDraft(initial);
    const [conflict, setConflict] = useState<AgentSource | null>(null);
    const dirty = draft !== base.source;
    const validation = useBookValidation(draft, canWrite);
    const adopt = (saved: AgentSource) => {
        setConflict(null);
        queryClient.setQueryData(bookKeys.source(agentId), saved);
    };

    const writeSource = (successMessage: () => string, errorMessage: (failure: ApiFailure) => string) => ({
        mutationFn: async (variables: Variables) =>
            unwrap(await engineApi.agents.updateSource(agentId, variables, AbortSignal.timeout(SAVE_TIMEOUT_MS))),
        invalidates: [bookKeys.revisions(agentId), agentKeys.detail(agentId), agentKeys.lists()],
        successMessage,
        errorMessage,
    });
    const save = useStepUpAwareMutation({
        ...writeSource(m.book_saved, saveFailureMessage),
        onSuccess: (result, submitted) => {
            adopt(result);
            saved(result, submitted.source);
        },
    });
    const restore = useStepUpAwareMutation(
        writeSource(m.book_restored, (failure) =>
            problemCode(failure) === 'revision-conflict' ? m.book_save_conflict() : m.book_restore_failed(),
        ),
    );

    const onWriteFailure = async (error: unknown) => {
        const failure = classifyApiError(error);
        if (failure.kind !== 'problem') return;
        if (failure.problem.code === 'invalid-book') validation.show(failure.problem.diagnostics ?? []);
        if (failure.problem.code === 'revision-conflict') {
            try {
                setConflict(await queryClient.query({ ...agentSourceQueryOptions(engineApi, agentId), staleTime: 0 }));
            } catch {
                // The conflict was reported in a toast; without the newer text there is nothing to compare.
            }
        }
    };

    const saveDraft = async () => {
        if (!canWrite || !dirty || save.isPending) return;
        try {
            await save.mutateAsync({ source: draft, baseRevisionId: base.revisionId });
        } catch (error) {
            await onWriteFailure(error);
        }
    };

    const restoreSource = async (revision: Revision) => {
        try {
            const saved = await restore.mutateAsync({ source: revision.source, baseRevisionId: base.revisionId });
            adopt(saved);
            reset();
            return saved;
        } catch (error) {
            await onWriteFailure(error);
            return undefined;
        }
    };

    const reload = () => {
        if (conflict === null) return;
        adopt(conflict);
        reset();
    };

    return {
        base,
        draft,
        change,
        dirty,
        conflict,
        canWrite,
        hasEditor,
        validation,
        save,
        saveDraft,
        restore,
        restoreSource,
        reload,
    };
}
