import type {
    AiToolAuthMethod,
    AiToolSignInId,
    AnswerAiToolSignInBody,
    ReadAiTool,
    ReadAiToolSignIn,
} from '@ptbk/engine-api';
import { Banner, Button, Dialog, Spinner, useToast } from '@ptbk/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { classifyApiError, unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { OnboardingActivityList } from '../onboarding/onboarding-activity';
import { PromptForm } from '../onboarding/prompt-form';
import type { PromptAnswer } from '../onboarding/prompt-form';
import { AI_TOOLS_POLL_MS, aiToolKeys, isSignInSettling } from './ai-tools-queries';

const REQUEST_TIMEOUT_MS = 30_000;

type Submit =
    | { readonly action: 'answer'; readonly answer: PromptAnswer }
    | { readonly action: 'alternative'; readonly alternativeId: string };

/** A key leaves its one-time holder here, so the mutation's retained variables never hold it. */
function answerBody(promptId: string, submit: Submit): AnswerAiToolSignInBody {
    if (submit.action === 'alternative')
        return { promptId, action: 'alternative', alternativeId: submit.alternativeId };
    const { answer } = submit;
    switch (answer.kind) {
        case 'secret':
            return { promptId, action: 'answer', answer: { kind: 'secret', value: answer.value.take() } };
        case 'harness-login':
            return { promptId, action: 'answer', answer };
        case 'text':
        case 'choice':
        case 'confirm':
        case 'upload':
            throw new Error(`A sign-in never asks for a ${answer.kind} answer`);
    }
}

function problemCode(error: unknown): string | null {
    const failure = classifyApiError(error);
    return failure.kind === 'problem' ? failure.problem.code : null;
}

/**
 * Signs one tool in again, in the engine's own steps: the provider's sign-in or an API key, with onboarding's forms, so
 * the owner sees exactly what setup showed. Closing an unfinished sign-in abandons it; the tool keeps what it had.
 */
export function AiToolSignInDialog({
    tool,
    method,
    onClose,
}: {
    readonly tool: ReadAiTool;
    readonly method: AiToolAuthMethod;
    readonly onClose: () => void;
}) {
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const toast = useToast();
    const [signInId, setSignInId] = useState<AiToolSignInId | null>(null);
    const [gone, setGone] = useState(false);
    const [failed, setFailed] = useState(false);
    const finished = useRef(false);

    const start = useStepUpAwareMutation({
        mutationFn: async () =>
            unwrap(await engineApi.aiTools.startSignIn(tool.id, { method }, AbortSignal.timeout(REQUEST_TIMEOUT_MS))),
        onSuccess: (started) => {
            queryClient.setQueryData(aiToolKeys.signIn(started.id), started);
            setGone(false);
            setSignInId(started.id);
        },
        errorMessage: () => m.ai_tools_sign_in_start_failed({ name: tool.name }),
    });
    const { mutate: begin } = start;
    const begun = useRef(false);
    useEffect(() => {
        // Once per dialog: a second start would end the first one on the engine.
        if (begun.current) return;
        begun.current = true;
        begin();
    }, [begin]);

    const current = useQuery({
        queryKey: aiToolKeys.signIn(signInId ?? 'none'),
        queryFn: async ({ signal }) => {
            if (signInId === null) throw new Error('no sign-in yet');
            return unwrap(await engineApi.aiTools.getSignIn(tool.id, signInId, signal));
        },
        enabled: signInId !== null && !gone,
        refetchInterval: (query) => (isSignInSettling(query.state.data) ? AI_TOOLS_POLL_MS : false),
        retry: false,
    });
    const signIn: ReadAiToolSignIn | undefined = current.data;
    if (current.isError && !gone && problemCode(current.error) === 'not-found') setGone(true);

    const answer = useMutation({
        mutationFn: async (submit: Submit) => {
            const shown = signIn?.prompt;
            if (signInId === null || shown === undefined || shown === null) throw new Error('no prompt to answer');
            return unwrap(
                await engineApi.aiTools.answerSignIn(
                    tool.id,
                    signInId,
                    answerBody(shown.id, submit),
                    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                ),
            );
        },
        onMutate: () => {
            setFailed(false);
        },
        onSuccess: (next) => {
            queryClient.setQueryData(aiToolKeys.signIn(next.id), next);
        },
        onError: (error) => {
            const code = problemCode(error);
            // The engine moved on (a device login confirmed meanwhile): show where it is now.
            if (code === 'ai-tool-sign-in-stale') void current.refetch();
            else if (code === 'not-found') setGone(true);
            else setFailed(true);
        },
    });

    useEffect(() => {
        if (signIn?.status !== 'completed' || finished.current) return;
        finished.current = true;
        void queryClient.invalidateQueries({ queryKey: aiToolKeys.list() });
        toast.show({ tone: 'success', title: m.ai_tools_signed_in({ name: tool.name }) });
        onClose();
    }, [signIn?.status, queryClient, toast, tool.name, onClose]);

    const close = () => {
        if (signInId !== null && !gone && signIn?.status !== 'completed') {
            void engineApi.aiTools.cancelSignIn(tool.id, signInId, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
        }
        onClose();
    };

    const restart = () => {
        setSignInId(null);
        begin();
    };

    let body;
    if (gone) {
        body = (
            <Banner
                tone="warning"
                action={
                    <Button size="sm" loading={start.isPending} onClick={restart}>
                        {m.ai_tools_sign_in_restart()}
                    </Button>
                }
            >
                {m.ai_tools_sign_in_gone()}
            </Banner>
        );
    } else if (signIn === undefined) {
        body = start.isError ? (
            <Banner
                tone="danger"
                action={
                    <Button size="sm" loading={start.isPending} onClick={restart}>
                        {m.ai_tools_sign_in_restart()}
                    </Button>
                }
            >
                {m.ai_tools_sign_in_start_failed({ name: tool.name })}
            </Banner>
        ) : (
            <p className="flex items-center gap-2 text-sm text-text-muted" role="status">
                <Spinner size="sm" announce={false} />
                {m.ai_tools_sign_in_starting({ name: tool.name })}
            </p>
        );
    } else if (signIn.prompt === null) {
        body = (
            <div className="flex flex-col gap-3" role="status">
                <p className="flex items-center gap-2 text-sm text-text-muted">
                    <Spinner size="sm" announce={false} />
                    {m.ai_tools_sign_in_verifying({ name: tool.name })}
                </p>
                <OnboardingActivityList activity={signIn.activity} />
            </div>
        );
    } else {
        body = (
            <div className="flex flex-col gap-4">
                {signIn.activity.length === 0 ? null : <OnboardingActivityList activity={signIn.activity} />}
                <PromptForm
                    // A new prompt (a refused key, another method) starts with empty fields.
                    key={signIn.prompt.id}
                    prompt={signIn.prompt}
                    busy={answer.isPending}
                    onAnswer={(value) => {
                        answer.mutate({ action: 'answer', answer: value });
                    }}
                    onBack={() => undefined}
                    onAlternative={(alternativeId) => {
                        answer.mutate({ action: 'alternative', alternativeId });
                    }}
                />
                {failed ? <Banner tone="danger">{m.ai_tools_answer_failed()}</Banner> : null}
            </div>
        );
    }

    return (
        <Dialog open onClose={close} title={m.ai_tools_sign_in_title({ name: tool.name })} size="md">
            {body}
        </Dialog>
    );
}
