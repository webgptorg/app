import type { AnswerOnboardingBody, ReadOnboardingPrompt, ReadOnboardingState } from '@ptbk/engine-api';
import { Banner, BrandRobot, Button, ErrorState, RobotGuide, Skeleton, Spinner } from '@ptbk/ui';
import type { RobotPose } from '@ptbk/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { classifyApiError, unwrap } from '../../app/api-errors';
import { cx } from '../../app/cx';
import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink } from '../../app/link';
import { m } from '../../paraglide/messages';
import { useDocumentTitle } from '../shell/document-title';
import { OnboardingActivityList } from './onboarding-activity';
import { onboardingKeys, onboardingQueryOptions } from './onboarding-queries';
import { PromptForm } from './prompt-form';
import type { PromptAnswer } from './prompt-form';
import { SetupProgressBar, SetupTimeline } from './onboarding-timeline';
import { useOpenChatter } from './use-open-chatter';

type Submit =
    | { readonly action: 'answer'; readonly answer: PromptAnswer }
    | { readonly action: 'back' }
    | { readonly action: 'alternative'; readonly alternativeId: string };

/** The request for one submit. A secret is taken out of its one-time holder here, so nothing retains it afterwards. */
function answerBody(promptId: string, submit: Submit): AnswerOnboardingBody {
    switch (submit.action) {
        case 'back':
            return { promptId, action: 'back' };
        case 'alternative':
            return { promptId, action: 'alternative', alternativeId: submit.alternativeId };
        case 'answer':
            return {
                promptId,
                action: 'answer',
                answer:
                    submit.answer.kind === 'secret'
                        ? { kind: 'secret', value: submit.answer.value.take() }
                        : submit.answer,
            };
    }
}

function isProblem(error: unknown, code: string): boolean {
    const failure = classifyApiError(error);
    return failure.kind === 'problem' && failure.problem.code === code;
}

/**
 * The title of each step this visit has seen, by the engine's step number, for the timeline. The newest title of a
 * number wins: Back and the engine's branches may put another prompt under it.
 */
function useStepTitles(state: ReadOnboardingState | undefined): ReadonlyMap<number, string> {
    const [titles, setTitles] = useState<ReadonlyMap<number, string>>(new Map());
    const step = state?.progress?.step;
    const title = state?.prompt?.title;
    if (step !== undefined && title !== undefined && titles.get(step) !== title) {
        setTitles(new Map(titles).set(step, title));
    }
    return titles;
}

/**
 * After the member's own answer the form they used is gone, so focus moves to the next step's heading, as in the agent
 * wizard. Never on a poll, which must not pull focus from a field being typed in.
 */
function useFocusAfterAnswer(): {
    readonly heading: RefObject<HTMLHeadingElement | null>;
    readonly answered: () => void;
} {
    const heading = useRef<HTMLHeadingElement>(null);
    const [answers, setAnswers] = useState(0);
    useEffect(() => {
        if (answers > 0) heading.current?.focus();
    }, [answers]);
    return {
        heading,
        answered: () => {
            setAnswers((count) => count + 1);
        },
    };
}

/**
 * The engine's setup questions, one at a time. The engine decides what comes next; this page renders its prompt,
 * sends the answer and shows what the engine answers. "Skip for now" leaves setup pending and goes to Chatter; an
 * engine with nothing to skip to yet offers no skip, and its answers are kept for the next visit.
 */
export function OnboardingPage() {
    useDocumentTitle(m.onboarding_title());
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const state = useQuery(onboardingQueryOptions(engineApi));
    const openChatter = useOpenChatter();
    const [failed, setFailed] = useState(false);
    const titles = useStepTitles(state.data);
    const focus = useFocusAfterAnswer();

    const answer = useMutation({
        mutationFn: async ({ prompt, submit }: { readonly prompt: ReadOnboardingPrompt; readonly submit: Submit }) => {
            const next = unwrap(
                await engineApi.onboarding.answer(answerBody(prompt.id, submit), AbortSignal.timeout(30_000)),
            );
            // A read still on its way (a poll, or the one on coming back to the tab) left before this answer and
            // would land after it, putting the answered prompt back with its old defaults.
            await queryClient.cancelQueries({ queryKey: onboardingKeys.state });
            return next;
        },
        onMutate: () => {
            setFailed(false);
        },
        onSuccess: (next) => {
            queryClient.setQueryData<ReadOnboardingState>(onboardingKeys.state, next);
            focus.answered();
        },
        onError: (error) => {
            // Another tab or the engine itself moved on: show where it is now rather than an error.
            if (isProblem(error, 'onboarding-prompt-stale')) {
                void queryClient.invalidateQueries({ queryKey: onboardingKeys.state });
                return;
            }
            setFailed(true);
        },
    });

    const skip = useMutation({
        mutationFn: async () => {
            const next = unwrap(await engineApi.onboarding.defer(AbortSignal.timeout(30_000)));
            await queryClient.cancelQueries({ queryKey: onboardingKeys.state });
            return next;
        },
        onSuccess: async (next) => {
            queryClient.setQueryData<ReadOnboardingState>(onboardingKeys.state, next);
            await openChatter();
        },
        onError: (error) => {
            // The engine has nothing to skip to after all; reading the state again takes the offer away.
            if (isProblem(error, 'onboarding-not-deferrable')) {
                void queryClient.invalidateQueries({ queryKey: onboardingKeys.state });
            }
        },
    });

    const open = state.data !== undefined && state.data.status !== 'completed';
    const progress = open ? state.data.progress : null;
    return (
        <section
            aria-labelledby="page-title"
            className={cx('mx-auto w-full max-w-xl py-2 md:py-10', progress !== null && 'lg:max-w-4xl')}
        >
            <div
                className={cx(progress !== null && 'lg:grid lg:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] lg:gap-x-16')}
            >
                {progress === null ? null : (
                    <aside className="max-lg:hidden">
                        <SetupTimeline progress={progress} titles={titles} className="sticky top-10 pt-2" />
                    </aside>
                )}
                <div className="flex min-w-0 flex-col gap-8">
                    {progress === null ? null : <SetupProgressBar progress={progress} className="lg:hidden" />}
                    {state.isPending ? (
                        <Skeleton shape="block" className="h-48 w-full" />
                    ) : state.isError ? (
                        <>
                            <h1 id="page-title" className="text-2xl font-semibold tracking-display">
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
                            heading={focus.heading}
                            onSubmit={(prompt, submit) => {
                                answer.mutate({ prompt, submit });
                            }}
                        />
                    )}
                    {failed ? <Banner tone="danger">{m.onboarding_answer_failed()}</Banner> : null}
                    {open && !state.data.canDefer ? (
                        <footer className="mt-2 border-t border-hairline pt-5">
                            <p className="meta">{m.onboarding_saved_hint()}</p>
                        </footer>
                    ) : null}
                    {open && state.data.canDefer ? (
                        <footer className="mt-2 flex flex-col gap-2 border-t border-hairline pt-5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                            <p className="meta">{m.onboarding_skip_hint()}</p>
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
                </div>
            </div>
        </section>
    );
}

/** The robot's line for each step: what this step is for, in Promptbook's voice; the engine's prompt says the rest. */
function guideFor(prompt: ReadOnboardingPrompt | null): { readonly pose: RobotPose; readonly line: string } {
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
        case 'secret':
            return { pose: 'working', line: m.onboarding_guide_secret() };
        case 'harness-login':
            return { pose: 'working', line: m.onboarding_guide_login() };
        case 'unsupported':
            return { pose: 'resting', line: m.onboarding_guide_unsupported() };
    }
}

const HEADING =
    'text-2xl font-semibold tracking-display focus-visible:rounded-small focus-visible:outline-2 focus-visible:outline-focus';

function OnboardingBody({
    state,
    busy,
    heading,
    onSubmit,
}: {
    readonly state: ReadOnboardingState;
    readonly busy: boolean;
    /** The step's `h1`, where focus goes after an answer. */
    readonly heading: RefObject<HTMLHeadingElement | null>;
    readonly onSubmit: (prompt: ReadOnboardingPrompt, submit: Submit) => void;
}) {
    if (state.status === 'completed') {
        return (
            <div className="flex flex-col gap-8">
                <RobotGuide pose="finished">{m.onboarding_guide_done()}</RobotGuide>
                <div className="flex flex-col gap-2">
                    <h1 ref={heading} id="page-title" tabIndex={-1} className={HEADING}>
                        {m.onboarding_done_title()}
                    </h1>
                    <p className="text-sm text-text-muted">{m.onboarding_done_body()}</p>
                </div>
                <div>
                    <ButtonLink to="/" variant="primary" size="lg">
                        {m.onboarding_done_home()}
                    </ButtonLink>
                </div>
            </div>
        );
    }
    const prompt = state.prompt;
    const guide = guideFor(prompt);
    // While a prompt waits, the work before it stays in view only when something failed, e.g. a harness that did not
    // install while setup goes on with another one.
    const keptActivity = prompt !== null && state.activity.some((item) => item.status === 'failed');
    return (
        <div className="flex flex-col gap-8">
            <RobotGuide pose={guide.pose}>{guide.line}</RobotGuide>
            {keptActivity ? (
                <OnboardingActivityList
                    activity={state.activity}
                    className="rounded-surface border border-hairline px-4 py-3"
                />
            ) : null}
            <div className="flex flex-col gap-6">
                {/* Prompt titles are the engine's words: a text node. */}
                <h1 ref={heading} id="page-title" tabIndex={-1} className={cx(HEADING, '[overflow-wrap:anywhere]')}>
                    {prompt === null ? m.onboarding_title() : prompt.title}
                </h1>
                {prompt !== null ? (
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
                        onAlternative={(alternativeId) => {
                            onSubmit(prompt, { action: 'alternative', alternativeId });
                        }}
                    />
                ) : state.activity.length === 0 ? (
                    <div className="flex items-center gap-3 text-sm text-text-muted" role="status">
                        <Spinner announce={false} />
                        {m.onboarding_working()}
                    </div>
                ) : (
                    // Not `role="status"`, which is atomic: each line that changes is read once, not the whole list.
                    <div aria-live="polite">
                        <OnboardingActivityList activity={state.activity} />
                    </div>
                )}
            </div>
        </div>
    );
}
