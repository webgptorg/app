import type { OnboardingAnswer, OnboardingPrompt } from '@ptbk/engine-api';
import { Banner, Button, ExternalLink, Field, Input, Spinner, Textarea } from '@ptbk/ui';
import { useId, useState } from 'react';
import type { ReactNode, SubmitEvent } from 'react';

import { m } from '../../paraglide/messages';
import { OnboardingUpload } from './onboarding-upload';
import type { UploadedFile } from './onboarding-upload';

type HarnessLoginPrompt = Extract<OnboardingPrompt, { kind: 'harness-login' }>;

interface PromptFormProps {
    readonly prompt: OnboardingPrompt;
    readonly busy: boolean;
    readonly onAnswer: (answer: OnboardingAnswer) => void;
    readonly onBack: () => void;
}

/** One prompt as the engine sent it. Its texts are the engine's and render as plain text. */
export function PromptForm({ prompt, busy, onAnswer, onBack }: PromptFormProps) {
    switch (prompt.kind) {
        case 'text':
            return <TextPrompt prompt={prompt} busy={busy} onAnswer={onAnswer} onBack={onBack} />;
        case 'choice':
            return <ChoicePrompt prompt={prompt} busy={busy} onAnswer={onAnswer} onBack={onBack} />;
        case 'confirm':
            return (
                <Frame prompt={prompt} onBack={onBack} busy={busy}>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            variant="primary"
                            loading={busy}
                            onClick={() => {
                                onAnswer({ kind: 'confirm', confirmed: true });
                            }}
                        >
                            {prompt.confirmLabel}
                        </Button>
                        <Button
                            disabled={busy}
                            onClick={() => {
                                onAnswer({ kind: 'confirm', confirmed: false });
                            }}
                        >
                            {prompt.declineLabel}
                        </Button>
                    </div>
                </Frame>
            );
        case 'upload':
            return <UploadPrompt prompt={prompt} busy={busy} onAnswer={onAnswer} onBack={onBack} />;
        case 'harness-login':
            return <HarnessLogin prompt={prompt} busy={busy} onAnswer={onAnswer} onBack={onBack} />;
    }
}

/** The question, the engine's hint and its refusal of the last answer, around the controls of one prompt. */
function Frame({
    prompt,
    busy,
    onBack,
    submit,
    onSubmit,
    children,
}: {
    readonly prompt: OnboardingPrompt;
    readonly busy: boolean;
    readonly onBack: () => void;
    /** A Continue button that submits the form; prompts that answer by their own buttons leave it out. */
    readonly submit?: { readonly disabled: boolean };
    readonly onSubmit?: () => void;
    readonly children: ReactNode;
}) {
    const handle = (event: SubmitEvent<HTMLFormElement>) => {
        event.preventDefault();
        onSubmit?.();
    };
    return (
        <form className="flex flex-col gap-4" onSubmit={handle} noValidate>
            {children}
            {prompt.error === null ? null : <Banner tone="danger">{prompt.error}</Banner>}
            <div className="flex flex-wrap items-center gap-2">
                {submit === undefined ? null : (
                    <Button type="submit" variant="primary" loading={busy} disabled={submit.disabled}>
                        {m.onboarding_continue()}
                    </Button>
                )}
                {prompt.canGoBack ? (
                    <Button variant="ghost" disabled={busy} onClick={onBack}>
                        {m.onboarding_back()}
                    </Button>
                ) : null}
            </div>
        </form>
    );
}

function TextPrompt({
    prompt,
    busy,
    onAnswer,
    onBack,
}: PromptFormProps & { readonly prompt: Extract<OnboardingPrompt, { kind: 'text' }> }) {
    const [text, setText] = useState(prompt.initial);
    const [files, setFiles] = useState<readonly UploadedFile[]>([]);
    const [uploading, setUploading] = useState(false);
    const blank = text.trim() === '';
    return (
        <Frame
            prompt={prompt}
            busy={busy}
            onBack={onBack}
            submit={{ disabled: uploading || (prompt.required && blank) }}
            onSubmit={() => {
                onAnswer({ kind: 'text', text, fileIds: files.map(({ id }) => id) });
            }}
        >
            <Field label={prompt.question} hint={prompt.hint ?? undefined} required={prompt.required}>
                {(control) =>
                    prompt.multiline ? (
                        <Textarea
                            {...control}
                            rows={8}
                            value={text}
                            placeholder={prompt.placeholder ?? undefined}
                            onChange={(event) => {
                                setText(event.target.value);
                            }}
                        />
                    ) : (
                        <Input
                            {...control}
                            value={text}
                            placeholder={prompt.placeholder ?? undefined}
                            onChange={(event) => {
                                setText(event.target.value);
                            }}
                        />
                    )
                }
            </Field>
            {prompt.attachments ? (
                <OnboardingUpload maxFiles={20} files={files} onChange={setFiles} onBusyChange={setUploading} />
            ) : null}
        </Frame>
    );
}

function ChoicePrompt({
    prompt,
    busy,
    onAnswer,
    onBack,
}: PromptFormProps & { readonly prompt: Extract<OnboardingPrompt, { kind: 'choice' }> }) {
    const [selected, setSelected] = useState<readonly string[]>(prompt.initial);
    const name = useId();
    const toggle = (id: string, checked: boolean) => {
        if (!prompt.multiple) setSelected([id]);
        else setSelected(checked ? [...selected, id] : selected.filter((other) => other !== id));
    };
    return (
        <Frame
            prompt={prompt}
            busy={busy}
            onBack={onBack}
            submit={{ disabled: selected.length === 0 }}
            onSubmit={() => {
                onAnswer({ kind: 'choice', choiceIds: [...selected] });
            }}
        >
            <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 font-medium">{prompt.question}</legend>
                {prompt.hint === null ? null : <p className="mb-2 text-sm text-text-muted">{prompt.hint}</p>}
                {prompt.choices.map((choice) => (
                    <label
                        key={choice.id}
                        className="flex cursor-pointer items-start gap-3 rounded-surface border border-divider bg-raised p-3 has-checked:border-accent has-disabled:cursor-not-allowed has-disabled:opacity-60"
                    >
                        <input
                            type={prompt.multiple ? 'checkbox' : 'radio'}
                            name={name}
                            className="mt-1 accent-(--color-accent)"
                            checked={selected.includes(choice.id)}
                            disabled={choice.disabled}
                            onChange={(event) => {
                                toggle(choice.id, event.target.checked);
                            }}
                        />
                        <span className="flex min-w-0 flex-col">
                            <span className="font-medium break-words">{choice.label}</span>
                            {choice.description === null ? null : (
                                <span className="text-sm break-words text-text-muted">{choice.description}</span>
                            )}
                        </span>
                    </label>
                ))}
            </fieldset>
        </Frame>
    );
}

function UploadPrompt({
    prompt,
    busy,
    onAnswer,
    onBack,
}: PromptFormProps & { readonly prompt: Extract<OnboardingPrompt, { kind: 'upload' }> }) {
    const [files, setFiles] = useState<readonly UploadedFile[]>([]);
    const [uploading, setUploading] = useState(false);
    return (
        <Frame
            prompt={prompt}
            busy={busy}
            onBack={onBack}
            submit={{ disabled: uploading || (prompt.required && files.length === 0) }}
            onSubmit={() => {
                onAnswer({ kind: 'upload', fileIds: files.map(({ id }) => id) });
            }}
        >
            <div className="flex flex-col gap-1">
                <p className="font-medium">{prompt.question}</p>
                {prompt.hint === null ? null : <p className="text-sm text-text-muted">{prompt.hint}</p>}
            </div>
            <OnboardingUpload
                maxFiles={prompt.maxFiles}
                files={files}
                onChange={setFiles}
                onBusyChange={setUploading}
            />
        </Frame>
    );
}

/**
 * The harness's own sign-in, exactly as the engine reports it: a link to the provider, the code to type there or a
 * field for the code the provider hands back. The code goes only to the engine, never into a chat.
 */
function HarnessLogin({ prompt, busy, onAnswer, onBack }: PromptFormProps & { readonly prompt: HarnessLoginPrompt }) {
    const [returnCode, setReturnCode] = useState('');
    const pending = prompt.status === 'waiting' || prompt.status === 'verifying';
    const failed = !pending && prompt.status !== 'succeeded';
    const pasting = prompt.method === 'return-code' && prompt.status === 'waiting';
    return (
        <Frame
            prompt={prompt}
            busy={busy}
            onBack={onBack}
            {...(pasting
                ? {
                      submit: { disabled: returnCode.trim() === '' },
                      onSubmit: () => {
                          onAnswer({ kind: 'harness-login', returnCode: returnCode.trim() });
                      },
                  }
                : {})}
        >
            <p>{prompt.question}</p>
            <ol className="flex list-decimal flex-col gap-3 ps-5">
                <li>
                    <ExternalLink href={prompt.url}>
                        {m.onboarding_login_open({ harness: prompt.harness })}
                    </ExternalLink>
                </li>
                {prompt.userCode === null ? null : (
                    <li className="flex flex-col gap-1">
                        <span>{m.onboarding_login_enter_code()}</span>
                        <code className="w-fit rounded-small bg-sunken px-3 py-2 font-mono text-xl tracking-widest select-all">
                            {prompt.userCode}
                        </code>
                    </li>
                )}
                {pasting ? (
                    <li>
                        <Field label={m.onboarding_login_return_code({ harness: prompt.harness })}>
                            {(control) => (
                                <Input
                                    {...control}
                                    value={returnCode}
                                    autoComplete="off"
                                    spellCheck={false}
                                    onChange={(event) => {
                                        setReturnCode(event.target.value);
                                    }}
                                />
                            )}
                        </Field>
                    </li>
                ) : null}
            </ol>
            {prompt.hint === null ? null : <p className="text-sm text-text-muted">{prompt.hint}</p>}
            {pending && prompt.method === 'device-code' ? (
                <p className="flex items-center gap-2 text-sm text-text-muted" role="status">
                    <Spinner size="sm" announce={false} />
                    {prompt.status === 'verifying' ? m.onboarding_login_verifying() : m.onboarding_login_waiting()}
                </p>
            ) : null}
            {failed ? (
                <Banner
                    tone="danger"
                    title={m.onboarding_login_failed()}
                    action={
                        <Button
                            size="sm"
                            loading={busy}
                            onClick={() => {
                                onAnswer({ kind: 'harness-login', returnCode: null });
                            }}
                        >
                            {m.onboarding_login_retry()}
                        </Button>
                    }
                >
                    {prompt.diagnostic ?? m.onboarding_login_failed_body()}
                </Banner>
            ) : null}
            <p className="text-sm text-text-muted">{m.onboarding_login_trust()}</p>
        </Frame>
    );
}
