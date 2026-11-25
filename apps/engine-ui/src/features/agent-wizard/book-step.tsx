import type { Agent } from '@ptbk/engine-api';
import type { ServerFieldError } from '@ptbk/ui';
import { Button } from '@ptbk/ui';
import { useCallback, useRef } from 'react';
import type { Ref } from 'react';

import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';

import { useAllows } from '../../app/registry/use-visible-features';
import { classifyApiError, unwrap } from '../../app/api-errors';
import type { ApiFailure } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { agentKeys } from '../agents/agents-keys';
import { ModelSettings } from '../book/model-settings';
import { BookEditor } from '../book/editor/book-editor';
import type { BookEditorHandle } from '../book/editor/book-editor';
import { ProblemsList } from '../book/problems-list';
import { useBookValidation } from '../book/use-book-validation';
import { StepFrame } from './step-frame';

/** Creation is not cancelled by navigation, so it carries its own timeout instead of a component's signal. */
const CREATE_TIMEOUT_MS = 30_000;

function createFailureMessage(failure: ApiFailure): string {
    if (failure.kind === 'problem' && failure.problem.code === 'invalid-book') return m.wizard_create_invalid();
    if (failure.kind === 'problem' && failure.problem.code === 'validation-failed') return m.wizard_create_rejected();
    return m.wizard_create_failed();
}

export interface BookStepProps {
    readonly draft: string;
    readonly onDraftChange: (source: string) => void;
    readonly headingRef: Ref<HTMLHeadingElement>;
    readonly onBack: () => void;
    readonly onCreated: (agent: Agent) => void;
    /** The engine refused fields of the create call; the brief step shows them. */
    readonly onServerErrors: (errors: readonly ServerFieldError[]) => void;
}

/**
 * Step 2: the book draft in the editor, checked as it is typed. "Create agent" creates the agent exactly once, however
 * often it is pressed; a book the engine refuses keeps the member here with its diagnostics in the editor.
 */
export function BookStep({ draft, onDraftChange, headingRef, onBack, onCreated, onServerErrors }: BookStepProps) {
    const engineApi = useEngineApi();
    const editor = useRef<BookEditorHandle>(null);
    const canValidate = useAllows({ capability: KNOWN_CAPABILITIES.bookEditor, permission: 'agents.write' });
    const validation = useBookValidation(draft, canValidate);
    const inFlight = useRef(false);
    const create = useStepUpAwareMutation({
        mutationFn: async (source: string) =>
            unwrap(await engineApi.agents.create({ source }, AbortSignal.timeout(CREATE_TIMEOUT_MS))),
        invalidates: [agentKeys.lists()],
        successMessage: (agent) => m.wizard_created({ name: agent.name }),
        errorMessage: createFailureMessage,
    });

    const submit = async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        try {
            onCreated(await create.mutateAsync(draft));
        } catch (error) {
            inFlight.current = false;
            const failure = classifyApiError(error);
            if (failure.kind !== 'problem') return;
            if (failure.problem.code === 'invalid-book') validation.show(failure.problem.diagnostics ?? []);
            if (failure.problem.code === 'validation-failed') onServerErrors(failure.problem.errors ?? []);
        }
    };

    const onChange = useCallback(
        (source: string) => {
            onDraftChange(source);
        },
        [onDraftChange],
    );

    return (
        <StepFrame
            title={m.wizard_book_title()}
            description={m.wizard_book_body()}
            headingRef={headingRef}
            actions={
                <>
                    <Button variant="ghost" onClick={onBack}>
                        {m.wizard_back()}
                    </Button>
                    <Button variant="primary" loading={create.isPending} onClick={() => void submit()}>
                        {m.wizard_create()}
                    </Button>
                </>
            }
        >
            <details className="mb-3">
                <summary className="cursor-pointer text-sm font-medium">{m.model_settings_title()}</summary>
                <div className="py-3">
                    <ModelSettings
                        source={draft}
                        editable
                        onChange={(source) => {
                            onDraftChange(source);
                            editor.current?.reset(source);
                        }}
                    />
                </div>
            </details>
            <BookEditor
                ref={editor}
                initialSource={draft}
                onChange={onChange}
                diagnostics={validation.diagnostics}
                label={m.book_editor_label()}
            />
            <ProblemsList
                diagnostics={validation.diagnostics}
                checking={validation.checking}
                failed={validation.failed}
                headingLevel={3}
                onSelect={(diagnostic) => editor.current?.focusRange(diagnostic.range)}
            />
        </StepFrame>
    );
}
