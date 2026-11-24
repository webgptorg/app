import { z } from 'zod';

import { FileId, OpaqueId, Timestamp } from '../common';
import { MAX_MESSAGE_LENGTH } from '../constants';
import { defineRoute } from '../route';
import { toTolerant } from '../tolerant';
import { KNOWN_CAPABILITIES } from './capability';

/**
 * Engine-driven onboarding (`onboarding@1`): the engine's own initializer (Reborn `ptbk init`) asks its questions one
 * prompt at a time, and the UI only renders the current prompt and returns the answer, like the engine's desktop
 * client does through its prompt presentation. The engine decides what comes next, validates every answer and says
 * when setup is done. Choice values, drafts and login state stay in the engine; the UI holds none of them.
 *
 * The prompt kinds are a fixed vocabulary the UI ships first; the engine composes its steps from them, so adding,
 * dropping or reordering a step needs no UI release. A paired engine can run this before it has a project.
 */

export const MAX_ONBOARDING_FILES = 20;
export const MAX_ONBOARDING_CHOICES = 32;
export const MAX_ONBOARDING_DETAILS = 16;
export const MAX_ONBOARDING_ALTERNATIVES = 4;
export const MAX_ONBOARDING_ACTIVITY = 16;
export const MAX_ONBOARDING_SECRET_LENGTH = 4096;
const ShortText = z.string().min(1).max(256);
const LongText = z.string().max(2048);
const HttpsUrl = z.url({ protocol: /^https$/ }).max(2048);

/** A new ID for every presentation of a prompt, so an answer to a prompt the engine moved past is refused. */
export const OnboardingPromptId = OpaqueId;

/**
 * A fact shown with the question, e.g. a line of the summary before "Create and start". `text`, not `value`: no
 * response carries a field named like a credential.
 */
export const OnboardingDetail = z.strictObject({ label: ShortText, text: LongText.min(1) });
export type OnboardingDetail = z.infer<typeof OnboardingDetail>;

/** A path on the engine's own origin; never another origin, protocol-relative or with a backslash. */
const EnginePath = z
    .string()
    .max(512)
    .regex(/^\/(?![/\\])[^\s\\]*$/);

/**
 * Another way through the current step, offered next to its answer: "Use an API key instead", "Sign in in a terminal
 * instead". Without `href` the UI sends `{ action: alternative }` and the engine presents what comes next. With `href`
 * it is a link the UI opens in a new tab and does not send, e.g. the engine's own native sign-in terminal.
 */
export const OnboardingAlternative = z.strictObject({
    id: OpaqueId,
    label: ShortText,
    description: LongText.nullable(),
    href: EnginePath.nullable(),
});
export type OnboardingAlternative = z.infer<typeof OnboardingAlternative>;

const promptBase = {
    id: OnboardingPromptId,
    /** The step's heading, e.g. "Your project". */
    title: ShortText,
    question: LongText.min(1),
    hint: LongText.nullable(),
    /** Why the engine refused the previous answer to this prompt; the UI shows it next to the input. */
    error: LongText.nullable(),
    canGoBack: z.boolean(),
    details: z.array(OnboardingDetail).max(MAX_ONBOARDING_DETAILS).default([]),
    alternatives: z.array(OnboardingAlternative).max(MAX_ONBOARDING_ALTERNATIVES).default([]),
};

export const OnboardingChoice = z.strictObject({
    /** Opaque to the client; the engine maps it back to its own value. */
    id: OpaqueId,
    label: ShortText,
    description: LongText.nullable(),
    disabled: z.boolean(),
});
export type OnboardingChoice = z.infer<typeof OnboardingChoice>;

/** Free text: a single line, or the long intent field ("What are you working on?") that may take files too. */
export const OnboardingTextPrompt = z.strictObject({
    ...promptBase,
    kind: z.literal('text'),
    multiline: z.boolean(),
    required: z.boolean(),
    placeholder: z.string().max(256).nullable(),
    /** The draft the engine kept, e.g. after Back. */
    initial: z.string().max(MAX_MESSAGE_LENGTH),
    /** Whether files may go with the text; the client uploads them with `files@1` (purpose `upload`) first. */
    attachments: z.boolean(),
});

export const OnboardingChoicePrompt = z.strictObject({
    ...promptBase,
    kind: z.literal('choice'),
    multiple: z.boolean(),
    choices: z.array(OnboardingChoice).min(1).max(MAX_ONBOARDING_CHOICES),
    /** Preselected choice IDs, e.g. the harnesses already installed. */
    initial: z.array(OpaqueId).max(MAX_ONBOARDING_CHOICES),
});

export const OnboardingConfirmPrompt = z.strictObject({
    ...promptBase,
    kind: z.literal('confirm'),
    confirmLabel: ShortText,
    declineLabel: ShortText,
});

/** Files the engine should have from the start; the client uploads them with `files@1` (purpose `upload`) first. */
export const OnboardingUploadPrompt = z.strictObject({
    ...promptBase,
    kind: z.literal('upload'),
    required: z.boolean(),
    maxFiles: z.int().min(1).max(MAX_ONBOARDING_FILES),
});

/**
 * A secret only the engine keeps, e.g. a provider API key. The engine never presents a value back (no `initial`),
 * and never logs, audits, puts in a draft, Book, chat or error the value it receives. A refused secret comes back as
 * the same kind of prompt with `error`, and the member types it again.
 */
export const OnboardingSecretPrompt = z.strictObject({
    ...promptBase,
    kind: z.literal('secret'),
    /** The field's label, e.g. "Gemini API key". */
    label: ShortText,
    placeholder: z.string().max(256).nullable(),
    /** Where the member gets the secret, e.g. the provider's API-key page. */
    helpUrl: HttpsUrl.nullable(),
});

export const HARNESS_LOGIN_METHODS = ['device-code', 'return-code'] as const;
export const HARNESS_LOGIN_STATUSES = [
    'waiting',
    'verifying',
    'succeeded',
    'failed',
    'expired',
    'denied',
    'unsupported',
] as const;
export type HarnessLoginStatus = (typeof HARNESS_LOGIN_STATUSES)[number];

/**
 * A native harness sign-in as the harness itself offers it (Reborn `specs/cli/harness-authentication.md`).
 * `device-code`: open `url` on any device and enter `userCode` there (Codex `--device-auth`); the engine notices
 * when it is done. `return-code`: open `url`, sign in, and paste the code the provider shows back into this prompt
 * (Claude Code). `userCode` and the returned code are transient: never logged, audited, stored or sent as chat.
 */
export const OnboardingHarnessLoginPrompt = z.strictObject({
    ...promptBase,
    kind: z.literal('harness-login'),
    /** The harness's name, e.g. "OpenAI Codex". */
    harness: ShortText,
    method: z.enum(HARNESS_LOGIN_METHODS),
    url: HttpsUrl,
    /** `device-code` only: what to type on the provider's page. */
    userCode: z.string().min(4).max(64).nullable(),
    status: z.enum(HARNESS_LOGIN_STATUSES),
    /** The concrete reason for `failed`, `expired`, `denied` or `unsupported`, in the engine's words. */
    diagnostic: LongText.nullable(),
    expiresAt: Timestamp.nullable(),
});

export const OnboardingPrompt = z.discriminatedUnion('kind', [
    OnboardingTextPrompt,
    OnboardingChoicePrompt,
    OnboardingConfirmPrompt,
    OnboardingUploadPrompt,
    OnboardingSecretPrompt,
    OnboardingHarnessLoginPrompt,
]);
export type OnboardingPrompt = z.infer<typeof OnboardingPrompt>;
export type OnboardingPromptKind = OnboardingPrompt['kind'];
export const ONBOARDING_PROMPT_KINDS = [
    'text',
    'choice',
    'confirm',
    'upload',
    'secret',
    'harness-login',
] as const satisfies readonly OnboardingPromptKind[];

/**
 * How a client reads a prompt of a kind this contract does not know yet: its heading and question survive, so the UI
 * can say the step needs a newer UI and keep polling instead of failing the whole state.
 */
export const UnsupportedOnboardingPromptReader = z
    .object({
        id: OnboardingPromptId,
        kind: z
            .string()
            .min(1)
            .max(64)
            .refine((kind) => !(ONBOARDING_PROMPT_KINDS as readonly string[]).includes(kind)),
        title: ShortText,
        question: LongText.min(1),
    })
    .transform(({ id, kind, title, question }) => ({
        kind: 'unsupported' as const,
        engineKind: kind,
        id,
        title,
        question,
    }));
export type UnsupportedOnboardingPrompt = z.output<typeof UnsupportedOnboardingPromptReader>;

export const ONBOARDING_ACTIVITY_STATUSES = ['running', 'done', 'failed', 'skipped'] as const;

/** One piece of work the engine reports while it sets up, e.g. "Install OpenAI Codex": done, or failed and why. */
export const OnboardingActivity = z.strictObject({
    id: OpaqueId,
    label: ShortText,
    status: z.enum(ONBOARDING_ACTIVITY_STATUSES),
    /** The concrete reason for `failed`, or a measured fact such as "240 MB of 1.2 GB"; never an estimate. */
    detail: LongText.nullable(),
});
export type OnboardingActivity = z.infer<typeof OnboardingActivity>;

/**
 * `pending`: a prompt waits for the member. `working`: the engine is busy (checking a harness, creating the project)
 * and has no prompt; poll. `completed`: set up, no prompt. `deferred` means the member chose "Skip for now": the UI
 * stops opening onboarding by itself, and the engine may finish setting itself up through its built-in agents.
 */
export const ONBOARDING_STATUSES = ['pending', 'working', 'completed'] as const;

const stateShape = {
    status: z.enum(ONBOARDING_STATUSES),
    deferred: z.boolean(),
    /**
     * `false` while the engine has no project yet (paired before setup): there is nothing to skip to, so the UI offers
     * no "Skip for now" and `defer` is 409 `onboarding-not-deferrable`. Answers are kept either way; the member can
     * close the page and continue later.
     */
    canDefer: z.boolean().default(true),
    /** "Step `step` of `of`", counted by the engine over the branches actually taken; `null` when it cannot say. */
    progress: z.strictObject({ step: z.int().min(1), of: z.int().min(1) }).nullable(),
    /** What the engine is doing or did in this phase, in order; shown while `working` and next to a prompt. */
    activity: z.array(OnboardingActivity).max(MAX_ONBOARDING_ACTIVITY).default([]),
};

export const OnboardingState = z.strictObject({
    ...stateShape,
    /** Present exactly while `status` is `pending`. */
    prompt: OnboardingPrompt.nullable(),
});
export type OnboardingState = z.infer<typeof OnboardingState>;

/** The client's reader: tolerant as usual, and a prompt of an unknown kind reads as `unsupported`. */
export const OnboardingStateReader = toTolerant(
    z.strictObject({
        ...stateShape,
        prompt: z.union([OnboardingPrompt, UnsupportedOnboardingPromptReader]).nullable(),
    }),
);
export type ReadOnboardingState = z.output<typeof OnboardingStateReader>;
export type ReadOnboardingPrompt = NonNullable<ReadOnboardingState['prompt']>;

export const OnboardingSecretAnswer = z.strictObject({
    kind: z.literal('secret'),
    value: z.string().min(1).max(MAX_ONBOARDING_SECRET_LENGTH),
});
/** `returnCode` for a `return-code` login; `null` asks the engine to start the sign-in again (retry). */
export const OnboardingHarnessLoginAnswer = z.strictObject({
    kind: z.literal('harness-login'),
    returnCode: z.string().min(1).max(512).nullable(),
});

export const OnboardingAnswer = z.discriminatedUnion('kind', [
    z.strictObject({
        kind: z.literal('text'),
        text: z.string().max(MAX_MESSAGE_LENGTH),
        fileIds: z.array(FileId).max(MAX_ONBOARDING_FILES).default([]),
    }),
    z.strictObject({ kind: z.literal('choice'), choiceIds: z.array(OpaqueId).max(MAX_ONBOARDING_CHOICES) }),
    z.strictObject({ kind: z.literal('confirm'), confirmed: z.boolean() }),
    z.strictObject({ kind: z.literal('upload'), fileIds: z.array(FileId).max(MAX_ONBOARDING_FILES) }),
    OnboardingSecretAnswer,
    OnboardingHarnessLoginAnswer,
]);
export type OnboardingAnswer = z.infer<typeof OnboardingAnswer>;

/**
 * `answer` carries an answer of the prompt's kind; `back` returns to the previous prompt with its draft kept and
 * carries no answer (400 `validation-failed` otherwise); `alternative` takes one of the prompt's alternatives without
 * `href`. An answer the engine cannot accept (an unknown choice, a missing file) comes back as the same prompt with
 * `error`.
 */
export const AnswerOnboardingBody = z.discriminatedUnion('action', [
    z.strictObject({ promptId: OnboardingPromptId, action: z.literal('answer'), answer: OnboardingAnswer }),
    z.strictObject({ promptId: OnboardingPromptId, action: z.literal('back') }),
    z.strictObject({ promptId: OnboardingPromptId, action: z.literal('alternative'), alternativeId: OpaqueId }),
]);
export type AnswerOnboardingBody = z.infer<typeof AnswerOnboardingBody>;

const capability = KNOWN_CAPABILITIES.onboarding;

export const ONBOARDING_ROUTES = {
    getOnboarding: defineRoute({
        id: 'getOnboarding',
        method: 'GET',
        path: '/onboarding',
        summary: 'Get the onboarding state and the prompt waiting for an answer',
        description: 'Poll while `status` is `working` or a harness login is `waiting` or `verifying`.',
        permission: 'settings.manage',
        capability,
        responses: { 200: { kind: 'json', schema: OnboardingState, read: OnboardingStateReader } },
    }),
    answerOnboarding: defineRoute({
        id: 'answerOnboarding',
        method: 'POST',
        path: '/onboarding/answer',
        summary: 'Answer the current prompt, or go back one; the engine decides what comes next',
        description:
            'A `promptId` that is not the current prompt is 409 `onboarding-prompt-stale` and changes nothing. An ' +
            'answer of another kind than the prompt, or an `alternativeId` the prompt does not offer without ' +
            '`href`, is 400 `validation-failed`. A returned login code or a secret is never logged or audited.',
        permission: 'settings.manage',
        capability,
        body: { kind: 'json', schema: AnswerOnboardingBody },
        responses: { 200: { kind: 'json', schema: OnboardingState, read: OnboardingStateReader } },
        problems: ['onboarding-prompt-stale'],
    }),
    deferOnboarding: defineRoute({
        id: 'deferOnboarding',
        method: 'POST',
        path: '/onboarding/defer',
        summary: '"Skip for now": keep the setup pending, and let the engine set itself up through its built-in agents',
        description:
            'Idempotent. Onboarding stays reachable; answering a prompt later continues where it stopped. 409 ' +
            '`onboarding-not-deferrable` while `canDefer` is false.',
        permission: 'settings.manage',
        capability,
        responses: { 200: { kind: 'json', schema: OnboardingState, read: OnboardingStateReader } },
        problems: ['onboarding-not-deferrable'],
    }),
} as const;
