import type { OnboardingAnswer, OnboardingPrompt, OnboardingState } from '@ptbk/engine-api';
import { Banner, Button, ErrorState, Skeleton, Spinner } from '@ptbk/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { classifyApiError, unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink } from '../../app/link';
import { m } from '../../paraglide/messages';
import { AgentAvatar } from '../agents/agent-avatar';
import { useDocumentTitle } from '../shell/document-title';
import { onboardingKeys, onboardingQueryOptions } from './onboarding-queries';
import { PromptForm } from './prompt-form';
import { useChatterLook } from './use-chatter-look';
import { useOpenChatter } from './use-open-chatter';

type Submit = { readonly action: 'answer'; readonly answer: OnboardingAnswer } | { readonly action: 'back' };

/**
 * The engine's setup questions, one at a time. The engine decides what comes next; this page renders its prompt,
 * sends the answer and shows what the engine answers. "Skip for now" leaves setup pending and goes to Chatter.
 */
export function OnboardingPage() {
    useDocumentTitle(m.onboarding_title());
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const state = useQuery(onboardingQueryOptions(engineApi));
    const openChatter = useOpenChatter();
    const [failed, setFailed] = useState(false);

    const answer = useMutation({
        mutationFn: async ({ prompt, submit }: { readonly prompt: OnboardingPrompt; readonly submit: Submit }) =>
            unwrap(
                await engineApi.onboarding.answer(
                    submit.action === 'back'
                        ? { promptId: prompt.id, action: 'back' }
                        : { promptId: prompt.id, action: 'answer', answer: submit.answer },
                    AbortSignal.timeout(30_000),
                ),
            ),
        onMutate: () => {
            setFailed(false);
        },
        onSuccess: (next) => {
            queryClient.setQueryData<OnboardingState>(onboardingKeys.state, next);
        },
        onError: (error) => {
            const failure = classifyApiError(error);
            // Another tab or the engine itself moved on: show where it is now rather than an error.
            if (failure.kind === 'problem' && failure.problem.code === 'onboarding-prompt-stale') {
                void queryClient.invalidateQueries({ queryKey: onboardingKeys.state });
                return;
            }
            setFailed(true);
        },
    });

    const skip = useMutation({
        mutationFn: async () => unwrap(await engineApi.onboarding.defer(AbortSignal.timeout(30_000))),
        onSuccess: async (next) => {
            queryClient.setQueryData<OnboardingState>(onboardingKeys.state, next);
            await openChatter();
        },
    });

    return (
        <section aria-labelledby="page-title" className="mx-auto flex w-full max-w-xl flex-col gap-8 py-2 md:py-10">
            {state.isPending ? (
                <Skeleton shape="block" className="h-48 w-full" />
            ) : state.isError ? (
                <>
                    <h1 id="page-title" className="text-xl font-semibold tracking-display">
                        {m.onboarding_title()}
                    </h1>
                    <ErrorState
                        message={m.onboarding_load_failed()}
                        onRetry={() => {
                            void state.refetch();
                        }}
                        retrying={state.isFetching}
                    />
                </>
            ) : (
                <OnboardingBody
                    state={state.data}
                    busy={answer.isPending}
                    onSubmit={(prompt, submit) => {
                        answer.mutate({ prompt, submit });
                    }}
                />
            )}
            {failed ? <Banner tone="danger">{m.onboarding_answer_failed()}</Banner> : null}
            {state.data !== undefined && state.data.status !== 'completed' ? (
                <footer className="flex flex-col gap-2 border-t border-hairline pt-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <p className="text-xs text-text-muted">{m.onboarding_skip_hint()}</p>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="self-start sm:self-auto"
                        loading={skip.isPending}
                        onClick={() => {
                            skip.mutate();
                        }}
                    >
                        {m.onboarding_skip()}
                    </Button>
                    {skip.isError ? <p className="text-xs text-danger">{m.onboarding_skip_failed()}</p> : null}
                </footer>
            ) : null}
        </section>
    );
}

/** Chatter as the one asking: its avatar and name, like the author line of a chat message. */
function ChatterLine({ children }: { readonly children?: ReactNode }) {
    const look = useChatterLook();
    return (
        <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex items-center gap-2">
                <AgentAvatar name={m.onboarding_chatter()} agentKey={look.key} profile={look.profile} size="xs" />
                <span className="text-sm font-medium">{m.onboarding_chatter()}</span>
            </span>
            {children}
        </div>
    );
}

/** Where setup stands, quietly: "Step 2 of 4" in tabular figures beside a thin line that fills as it goes. */
function StepProgress({ step, of }: { readonly step: number; readonly of: number }) {
    const label = m.onboarding_step({ step, of });
    return (
        <span className="ms-auto flex items-center gap-2.5">
            <span className="text-xs text-text-muted tabular-nums">{label}</span>
            <progress className="onboarding-progress h-1 w-20" value={step} max={of} aria-label={label} />
        </span>
    );
}

function OnboardingBody({
    state,
    busy,
    onSubmit,
}: {
    readonly state: OnboardingState;
    readonly busy: boolean;
    readonly onSubmit: (prompt: OnboardingPrompt, submit: Submit) => void;
}) {
    if (state.status === 'completed') {
        return (
            <div className="flex flex-col gap-5">
                <ChatterLine />
                <div className="flex flex-col gap-2">
                    <h1 id="page-title" className="flex items-center gap-2 text-xl font-semibold tracking-display">
                        <CircleCheck aria-hidden className="size-5 shrink-0 text-success" />
                        {m.onboarding_done_title()}
                    </h1>
                    <p className="text-sm text-text-muted">{m.onboarding_done_body()}</p>
                </div>
                <div>
                    <ButtonLink to="/" variant="primary">
                        {m.onboarding_done_home()}
                    </ButtonLink>
                </div>
            </div>
        );
    }
    const prompt = state.prompt;
    return (
        <div className="flex flex-col gap-5">
            <ChatterLine>
                {state.progress === null ? null : <StepProgress step={state.progress.step} of={state.progress.of} />}
            </ChatterLine>
            {/* Prompt titles are the engine's words: a text node. */}
            <h1 id="page-title" className="text-xl font-semibold tracking-display [overflow-wrap:anywhere]">
                {prompt === null ? m.onboarding_title() : prompt.title}
            </h1>
            {prompt === null ? (
                <div className="flex items-center gap-3 text-sm text-text-muted" role="status">
                    <Spinner announce={false} />
                    {m.onboarding_working()}
                </div>
            ) : (
                <PromptForm
                    key={prompt.id}
                    prompt={prompt}
                    busy={busy}
                    onAnswer={(value) => {
                        onSubmit(prompt, { action: 'answer', answer: value });
                    }}
                    onBack={() => {
                        onSubmit(prompt, { action: 'back' });
                    }}
                />
            )}
        </div>
    );
}
