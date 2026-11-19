import type {
    OnboardingAnswer,
    ReadOnboardingPrompt as OnboardingPrompt,
    ReadOnboardingState as OnboardingState,
} from '@ptbk/engine-api';
import { Banner, BrandRobot, Button, ErrorState, RobotGuide, Skeleton, Spinner } from '@ptbk/ui';
import type { RobotPose } from '@ptbk/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
        <section aria-labelledby="page-title" className="mx-auto flex w-full max-w-xl flex-col gap-8 py-2 md:py-10">
            {state.isPending ? (
                <Skeleton shape="block" className="h-48 w-full" />
            ) : state.isError ? (
                <>
                    <h1 id="page-title" className="text-xl font-semibold tracking-display">
                        {m.onboarding_title()}
                    </h1>
                    <ErrorState
                        illustration={<BrandRobot pose="resting" />}
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

/** The robot's line for each step: what this step is for, in Promptbook's voice; the engine's prompt says the rest. */
function guideFor(prompt: OnboardingPrompt | null): { readonly pose: RobotPose; readonly line: string } {
    switch (prompt?.kind) {
        case undefined:
            return { pose: 'assembling', line: m.onboarding_guide_working() };
        case 'text':
            return { pose: 'thinking', line: m.onboarding_guide_text() };
        case 'choice':
            return { pose: 'thinking', line: m.onboarding_guide_choice() };
        case 'confirm':
            return { pose: 'working', line: m.onboarding_guide_confirm() };
        case 'upload':
            return { pose: 'assembling', line: m.onboarding_guide_upload() };
        case 'harness-login':
            return { pose: 'working', line: m.onboarding_guide_login() };
        case 'secret':
        case 'unsupported':
        default:
            return { pose: 'working', line: m.onboarding_guide_other() };
    }
}

/** Where setup stands, quietly: "Step 2 of 4" in tabular figures beside a thin line that fills as it goes. */
function StepProgress({ step, of }: { readonly step: number; readonly of: number }) {
    const label = m.onboarding_step({ step, of });
    return (
        <span className="ms-auto flex items-center gap-2.5 self-start">
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
                <RobotGuide pose="finished">{m.onboarding_guide_done()}</RobotGuide>
                <div className="flex flex-col gap-2">
                    <h1 id="page-title" className="text-xl font-semibold tracking-display">
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
    const guide = guideFor(prompt);
    return (
        <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <RobotGuide pose={guide.pose} className="min-w-0 flex-1 basis-64">
                    {guide.line}
                </RobotGuide>
                {state.progress === null ? null : <StepProgress step={state.progress.step} of={state.progress.of} />}
            </div>
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
