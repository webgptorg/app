import type { OnboardingAnswer, OnboardingPrompt, OnboardingState } from '@ptbk/engine-api';
import { Banner, Button, Spinner } from '@ptbk/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';

import { classifyApiError, unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink } from '../../app/link';
import { m } from '../../paraglide/messages';
import { useDocumentTitle } from '../shell/document-title';
import { onboardingKeys, onboardingQueryOptions } from './onboarding-queries';
import { PromptForm } from './prompt-form';
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
        <section aria-labelledby="page-title" className="mx-auto flex w-full max-w-xl flex-col gap-6 py-2 md:py-6">
            {state.isPending ? (
                <Spinner />
            ) : state.isError ? (
                <Banner tone="danger" title={m.onboarding_load_failed()}>
                    <Button
                        size="sm"
                        onClick={() => {
                            void state.refetch();
                        }}
                    >
                        {m.onboarding_retry()}
                    </Button>
                </Banner>
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
                <div className="flex flex-col items-start gap-1 border-t border-divider pt-4 text-sm text-text-muted">
                    <Button
                        variant="ghost"
                        size="sm"
                        loading={skip.isPending}
                        onClick={() => {
                            skip.mutate();
                        }}
                    >
                        {m.onboarding_skip()}
                    </Button>
                    <p>{m.onboarding_skip_hint()}</p>
                    {skip.isError ? <p className="text-danger">{m.onboarding_skip_failed()}</p> : null}
                </div>
            ) : null}
        </section>
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
            <div className="flex flex-col items-start gap-4">
                <CheckCircle2 aria-hidden className="size-8 text-success" />
                <h1 id="page-title" className="text-2xl font-semibold">
                    {m.onboarding_done_title()}
                </h1>
                <p className="text-text-muted">{m.onboarding_done_body()}</p>
                <ButtonLink to="/" variant="primary">
                    {m.onboarding_done_home()}
                </ButtonLink>
            </div>
        );
    }
    const prompt = state.prompt;
    return (
        <div className="flex flex-col gap-5">
            <header className="flex flex-col gap-2">
                {state.progress === null ? null : (
                    <>
                        <p className="text-sm text-text-muted">
                            {m.onboarding_step({ step: state.progress.step, of: state.progress.of })}
                        </p>
                        <progress
                            className="onboarding-progress h-1.5 w-full"
                            value={state.progress.step}
                            max={state.progress.of}
                            aria-label={m.onboarding_step({ step: state.progress.step, of: state.progress.of })}
                        />
                    </>
                )}
                <h1 id="page-title" className="text-2xl font-semibold break-words">
                    {prompt === null ? m.onboarding_title() : prompt.title}
                </h1>
            </header>
            {prompt === null ? (
                <div className="flex items-center gap-3 text-text-muted" role="status">
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
