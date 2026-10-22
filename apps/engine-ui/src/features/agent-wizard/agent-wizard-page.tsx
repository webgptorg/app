import type { Agent, AgentId, ChatId } from '@ptbk/engine-api';
import { Button, Dialog, useZodForm } from '@ptbk/ui';
import type { ServerFieldError } from '@ptbk/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Ref } from 'react';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { agentKeys } from '../agents/agents-keys';
import { agentDetailQueryOptions } from '../agents/agents-queries';
import { UnsavedChangesGuard } from '../book/unsaved-changes-guard';
import { usePermissions } from '../session/use-permissions';
import { Page } from '../shell/page';
import { BookStep } from './book-step';
import { bookTemplate } from './book-template';
import { BriefSchema, BriefStep } from './brief-step';
import { DoneStep } from './done-step';
import { KnowledgeStep } from './knowledge-step';
import { TestStep } from './test-step';
import { CREATED_STEPS } from './wizard-search';
import type { WizardStep } from './wizard-search';
import { WizardStepper } from './wizard-stepper';

const route = getRouteApi('/agents/new');

const DELETE_TIMEOUT_MS = 30_000;
const NO_ERRORS: readonly ServerFieldError[] = [];

/**
 * The step to show for the URL's step: later steps need the created agent, earlier ones only make sense before it
 * exists, and the book step needs the brief, which a reload loses.
 */
function reachableStep(step: WizardStep, agentId: AgentId | undefined, hasDraft: boolean): WizardStep {
    if (agentId !== undefined) return CREATED_STEPS.has(step) ? step : 'knowledge';
    if (CREATED_STEPS.has(step)) return 'brief';
    return step === 'book' && !hasDraft ? 'brief' : step;
}

interface CancelDialogProps {
    readonly agentId: AgentId;
    readonly agentName: string;
    readonly onClose: () => void;
}

/** Leaving after the agent exists: keep it, or delete it again. */
function CancelDialog({ agentId, agentName, onClose }: CancelDialogProps) {
    const engineApi = useEngineApi();
    const navigate = useNavigate();
    const { can } = usePermissions();
    const remove = useStepUpAwareMutation({
        mutationFn: async () => unwrap(await engineApi.agents.delete(agentId, AbortSignal.timeout(DELETE_TIMEOUT_MS))),
        invalidates: [agentKeys.lists(), agentKeys.details()],
        successMessage: () => m.agent_deleted({ name: agentName }),
        onSuccess: () => {
            void navigate({ to: '/agents' });
        },
    });
    return (
        <Dialog
            open
            size="sm"
            onClose={onClose}
            title={m.wizard_cancel_title()}
            description={m.wizard_cancel_body({ name: agentName })}
            footer={
                <>
                    <Button variant="ghost" onClick={onClose}>
                        {m.wizard_cancel_stay()}
                    </Button>
                    <Button
                        variant="secondary"
                        onClick={() => {
                            void navigate({ to: '/agents/$agentId', params: { agentId } });
                        }}
                    >
                        {m.wizard_cancel_keep()}
                    </Button>
                    {can('agents.delete') ? (
                        <Button
                            variant="danger"
                            loading={remove.isPending}
                            onClick={() => {
                                if (!remove.isPending) remove.mutate();
                            }}
                        >
                            {m.wizard_cancel_delete()}
                        </Button>
                    ) : null}
                </>
            }
        />
    );
}

interface CreatedStepsProps {
    readonly agentId: AgentId;
    readonly step: WizardStep;
    readonly chatId: ChatId | undefined;
    readonly headingRef: Ref<HTMLHeadingElement>;
    readonly goTo: (step: WizardStep, extra?: { readonly chat?: ChatId }) => void;
}

/** Knowledge, test chat and done: the steps after the agent exists. */
function CreatedSteps({ agentId, step, chatId, headingRef, goTo }: CreatedStepsProps) {
    const agentName = useQuery(agentDetailQueryOptions(useEngineApi(), agentId)).data?.name ?? '';
    const [cancelling, setCancelling] = useState(false);
    const cancel = () => {
        setCancelling(true);
    };

    let content;
    if (step === 'test') {
        content = (
            <TestStep
                agentId={agentId}
                agentName={agentName}
                chatId={chatId}
                headingRef={headingRef}
                onChatCreated={(chat) => {
                    goTo('test', { chat });
                }}
                onNext={() => {
                    goTo('done');
                }}
                onCancel={cancel}
            />
        );
    } else if (step === 'done') {
        content = <DoneStep agentId={agentId} agentName={agentName} headingRef={headingRef} />;
    } else {
        content = (
            <KnowledgeStep
                agentId={agentId}
                headingRef={headingRef}
                onNext={() => {
                    goTo('test');
                }}
                onCancel={cancel}
            />
        );
    }
    return (
        <>
            {content}
            {cancelling ? (
                <CancelDialog
                    agentId={agentId}
                    agentName={agentName}
                    onClose={() => {
                        setCancelling(false);
                    }}
                />
            ) : null}
        </>
    );
}

/**
 * The create-agent wizard: brief, book, knowledge, test chat, done. The step is in the URL; the brief and the book
 * draft live only in this component until the book step creates the agent, after which the URL carries its ID.
 */
export function AgentWizardPage() {
    const search = route.useSearch();
    const navigate = route.useNavigate();
    const queryClient = useQueryClient();
    const [bookDraft, setBookDraft] = useState<string | null>(null);
    const [serverErrors, setServerErrors] = useState<readonly ServerFieldError[]>(NO_ERRORS);
    const lastTemplate = useRef<string | null>(null);
    const headingRef = useRef<HTMLHeadingElement>(null);
    const agentId = search.agent;
    const step = reachableStep(search.step, agentId, bookDraft !== null);

    const goTo = useCallback(
        (next: WizardStep, extra: { readonly agent?: AgentId; readonly chat?: ChatId } = {}) => {
            void navigate({ search: (previous) => ({ ...previous, ...extra, step: next }) });
        },
        [navigate],
    );

    const briefForm = useZodForm({
        schema: BriefSchema,
        defaultValues: { name: '', description: '' },
        onSubmit: (values) => {
            const template = bookTemplate(values);
            // A draft nobody has edited yet follows the brief; an edited one is the member's and stays.
            setBookDraft((draft) => (draft === null || draft === lastTemplate.current ? template : draft));
            lastTemplate.current = template;
            setServerErrors(NO_ERRORS);
            goTo('book');
        },
    });

    useEffect(() => {
        if (step !== search.step) void navigate({ search: (previous) => ({ ...previous, step }), replace: true });
    }, [step, search.step, navigate]);

    const shownStep = useRef(step);
    useEffect(() => {
        if (shownStep.current === step) return;
        shownStep.current = step;
        headingRef.current?.focus();
    }, [step]);

    let content;
    if (agentId !== undefined) {
        content = (
            <CreatedSteps agentId={agentId} step={step} chatId={search.chat} headingRef={headingRef} goTo={goTo} />
        );
    } else if (step === 'book' && bookDraft !== null) {
        content = (
            <BookStep
                draft={bookDraft}
                onDraftChange={setBookDraft}
                headingRef={headingRef}
                onBack={() => {
                    goTo('brief');
                }}
                onCreated={(agent: Agent) => {
                    // Cached before navigating, so the next steps show the name without a fetch.
                    queryClient.setQueryData(agentKeys.detail(agent.id), agent);
                    goTo('knowledge', { agent: agent.id });
                }}
                onServerErrors={(errors) => {
                    setServerErrors(errors);
                    goTo('brief');
                }}
            />
        );
    } else {
        content = (
            <BriefStep
                form={briefForm}
                headingRef={headingRef}
                serverErrors={serverErrors}
                onCancel={() => {
                    void navigate({ to: '/agents' });
                }}
            />
        );
    }

    return (
        <Page title={m.agents_new()}>
            <briefForm.Subscribe selector={(state) => state.isDirty}>
                {(briefDirty) => (
                    <UnsavedChangesGuard when={agentId === undefined && (briefDirty || bookDraft !== null)} />
                )}
            </briefForm.Subscribe>
            <WizardStepper current={step} />
            {content}
        </Page>
    );
}
