import { z } from 'zod';

import { AiToolId, AiToolSignInId, OpaqueId, Timestamp } from '../common';
import { defineRoute } from '../route';
import { openEnum, toTolerant } from '../tolerant';
import { KNOWN_CAPABILITIES } from './capability';
import {
    MAX_ONBOARDING_ACTIVITY,
    OnboardingActivity,
    OnboardingHarnessLoginAnswer,
    OnboardingHarnessLoginPrompt,
    OnboardingPromptId,
    OnboardingSecretAnswer,
    OnboardingSecretPrompt,
    UnsupportedOnboardingPromptReader,
} from './onboarding';

/**
 * AI tools (`ai-tools@1`): the coding tools a project's agents run on (Claude Code, OpenAI Codex, Gemini CLI, …), the
 * Reborn engine's harnesses. Members who oversee the project see each tool's status and run a real check; the owner
 * signs a tool in again, or gives it an API key, from the browser. A sign-in reuses onboarding's `harness-login` and
 * `secret` prompts, so the engine and the UI each have one implementation of them.
 *
 * Credentials stay on the engine: an API key goes only into the engine's own store and is never sent back, logged,
 * audited or put into an error; a login's codes are transient. Design: docs/engine-integration/ai-tools.md.
 */

export const MAX_AI_TOOLS = 16;
const ShortText = z.string().min(1).max(256);
const LongText = z.string().min(1).max(2048);

/**
 * `signed-in`: the last real check got an answer. `needs-sign-in`: never signed in, signed out, or its sign-in expired
 * or was revoked; the owner fixes it here. `error`: signed in, but the last check failed for another reason (a key
 * refused, a quota, the provider down). `not-installed`: the engine knows the tool but it is not on this host.
 */
export const AI_TOOL_STATUSES = ['signed-in', 'needs-sign-in', 'error', 'not-installed'] as const;
export type AiToolStatus = (typeof AI_TOOL_STATUSES)[number];

/** `account`: the provider's own sign-in (a Claude or ChatGPT account). `api-key`: a key in the engine's store. */
export const AI_TOOL_AUTH_METHODS = ['account', 'api-key'] as const;
export const AiToolAuthMethod = z.enum(AI_TOOL_AUTH_METHODS);
export type AiToolAuthMethod = z.infer<typeof AiToolAuthMethod>;

/** Why a tool is not `signed-in`, as a closed code the UI words itself; `message` carries the engine's detail. */
export const AI_TOOL_PROBLEM_CODES = [
    /** It was signed in and the provider no longer accepts that sign-in (expired, revoked, refresh failed). */
    'sign-in-expired',
    /** It was never signed in on this project, or it was signed out. */
    'not-signed-in',
    /** The provider refused the API key. */
    'key-rejected',
    /** The account or key is out of quota or credit. */
    'quota-exceeded',
    /** The provider did not answer or answered with an error of its own. */
    'provider-unavailable',
    /** The check failed for another reason; `message` says which. */
    'check-failed',
    'not-installed',
] as const;
export type AiToolProblemCode = (typeof AI_TOOL_PROBLEM_CODES)[number];

/** `message` is the engine's words or the tool's own diagnostic: untrusted text, rendered as text, never a secret. */
export const AiToolProblem = z.strictObject({ code: z.enum(AI_TOOL_PROBLEM_CODES), message: LongText });
export type AiToolProblem = z.infer<typeof AiToolProblem>;

/**
 * How the tool is set up to authenticate. `account` is what the provider calls the signed-in account (an email, a plan
 * name), `null` when it does not say and always for `api-key`: nothing about a key is ever sent.
 */
export const AiToolAuth = z.strictObject({ method: AiToolAuthMethod, account: ShortText.nullable() });
export type AiToolAuth = z.infer<typeof AiToolAuth>;

const toolFields = {
    id: AiToolId,
    /** The tool's own name, e.g. "Claude Code". */
    name: ShortText,
    /** The installed version as the tool reports it; `null` when not installed or unknown. */
    version: z.string().min(1).max(64).nullable(),
    /** How it authenticates now; `null` while it has no credentials (never signed in, signed out, not installed). */
    auth: AiToolAuth.nullable(),
    /** The ways the owner can sign it in from the browser, in the engine's order; empty when only the host can. */
    signInMethods: z
        .array(AiToolAuthMethod)
        .max(AI_TOOL_AUTH_METHODS.length)
        .refine((methods) => new Set(methods).size === methods.length, { message: 'Each method may appear once' }),
    /** When a real call to the provider last finished, whatever its outcome; `null` before the first. */
    checkedAt: Timestamp.nullable(),
    /** A check runs now; `ai-tool.changed` follows when it ends. */
    checking: z.boolean(),
};

export const AiTool = z
    .strictObject({ ...toolFields, status: z.enum(AI_TOOL_STATUSES), problem: AiToolProblem.nullable() })
    .refine((tool) => (tool.problem === null) === (tool.status === 'signed-in'), {
        message: 'A tool has a problem exactly when it is not signed in',
        path: ['problem'],
    });
export type AiTool = z.infer<typeof AiTool>;

/**
 * A status, method or problem code a newer engine adds reads as `unknown`, so one tool never fails the whole list.
 * Without `refine`: a reader judges each field, not the engine's consistency.
 */
export const AiToolReader = toTolerant(
    z.object({
        ...toolFields,
        auth: z.object({ method: openEnum(AI_TOOL_AUTH_METHODS), account: ShortText.nullable() }).nullable(),
        signInMethods: z.array(openEnum(AI_TOOL_AUTH_METHODS)).max(8),
        status: openEnum(AI_TOOL_STATUSES),
        problem: z.object({ code: openEnum(AI_TOOL_PROBLEM_CODES), message: LongText }).nullable(),
    }),
);
export type ReadAiTool = z.output<typeof AiToolReader>;

/** Every tool the engine knows, in its own order (the one its agents prefer first). No paging: there are few. */
export const AiToolList = z.strictObject({ items: z.array(AiTool).max(MAX_AI_TOOLS) });
export const AiToolListReader = z.object({ items: z.array(AiToolReader).max(MAX_AI_TOOLS) });

export const AiToolParams = z.strictObject({ aiToolId: AiToolId });
export const AiToolSignInParams = z.strictObject({ aiToolId: AiToolId, signInId: AiToolSignInId });

/** `account` starts the provider's sign-in (a `harness-login` prompt); `api-key` asks for a key (a `secret` prompt). */
export const StartAiToolSignInBody = z.strictObject({ method: AiToolAuthMethod });

/** The prompts a sign-in shows: exactly onboarding's, so one form renders both. `canGoBack` is always `false`. */
export const AiToolSignInPrompt = z.discriminatedUnion('kind', [OnboardingHarnessLoginPrompt, OnboardingSecretPrompt]);
export type AiToolSignInPrompt = z.infer<typeof AiToolSignInPrompt>;

/**
 * `pending`: a prompt waits for the owner (or for the provider, while a device login is `waiting`); poll. `working`:
 * the engine verifies new credentials with a real call and shows no prompt; poll. `completed`: verified, `tool` is
 * `signed-in` and the new credentials are in use.
 */
export const AI_TOOL_SIGN_IN_STATUSES = ['pending', 'working', 'completed'] as const;

const signInFields = {
    id: AiToolSignInId,
    aiToolId: AiToolId,
    /** The method shown now; an alternative may switch it ("Use an API key instead"). */
    method: AiToolAuthMethod,
    /** The engine's verification steps, e.g. "Check Claude Code": running, done or failed and why. */
    activity: z.array(OnboardingActivity).max(MAX_ONBOARDING_ACTIVITY).default([]),
    /** The engine forgets an unfinished sign-in after this; reading it then is 404. */
    expiresAt: Timestamp,
};

/**
 * One owner's attempt to sign a tool in, bound to the gateway session that started it: any other session, the same
 * member's included, gets 404 for it. A tool has at most one; starting another ends the previous one.
 */
export const AiToolSignIn = z.strictObject({
    ...signInFields,
    status: z.enum(AI_TOOL_SIGN_IN_STATUSES),
    /** Present exactly while `status` is `pending`. */
    prompt: AiToolSignInPrompt.nullable(),
    /** The tool as it is now. */
    tool: AiTool,
});
export type AiToolSignIn = z.infer<typeof AiToolSignIn>;

/** Tolerant, with a prompt of a kind this contract does not know read as `unsupported`, as in onboarding. */
export const AiToolSignInReader = toTolerant(
    z.object({
        ...signInFields,
        status: openEnum(AI_TOOL_SIGN_IN_STATUSES),
        prompt: z.union([AiToolSignInPrompt, UnsupportedOnboardingPromptReader]).nullable(),
        tool: AiToolReader,
    }),
);
export type ReadAiToolSignIn = z.output<typeof AiToolSignInReader>;

/**
 * `answer` carries the prompt's kind of answer; `alternative` takes one of its alternatives without `href`. A refused
 * key or code comes back as the same kind of prompt with `error` and a new `id`; the refused value is not kept.
 */
export const AnswerAiToolSignInBody = z.discriminatedUnion('action', [
    z.strictObject({
        promptId: OnboardingPromptId,
        action: z.literal('answer'),
        answer: z.discriminatedUnion('kind', [OnboardingSecretAnswer, OnboardingHarnessLoginAnswer]),
    }),
    z.strictObject({ promptId: OnboardingPromptId, action: z.literal('alternative'), alternativeId: OpaqueId }),
]);
export type AnswerAiToolSignInBody = z.infer<typeof AnswerAiToolSignInBody>;

/** A tool changed: its status, a check started or ended, a sign-in completed. Sent to members with `ai-tools.read`. */
export const AiToolChangedEvent = z.strictObject({ type: z.literal('ai-tool.changed'), aiToolId: AiToolId });

const capability = KNOWN_CAPABILITIES.aiTools;
const oneTool = { kind: 'json', schema: AiTool, read: AiToolReader } as const;
const oneSignIn = { kind: 'json', schema: AiToolSignIn, read: AiToolSignInReader } as const;

export const AI_TOOL_ROUTES = {
    listAiTools: defineRoute({
        id: 'listAiTools',
        method: 'GET',
        path: '/ai-tools',
        summary: "List the project's AI tools with their status, in the engine's order",
        permission: 'ai-tools.read',
        capability,
        responses: { 200: { kind: 'json', schema: AiToolList, read: AiToolListReader } },
    }),
    getAiTool: defineRoute({
        id: 'getAiTool',
        method: 'GET',
        path: '/ai-tools/{aiToolId}',
        summary: 'Get an AI tool',
        description: 'Poll while `checking` is true, or listen for `ai-tool.changed`.',
        permission: 'ai-tools.read',
        capability,
        params: AiToolParams,
        responses: { 200: oneTool },
    }),
    checkAiTool: defineRoute({
        id: 'checkAiTool',
        method: 'POST',
        path: '/ai-tools/{aiToolId}/check',
        summary: 'Check now: make a real call through the tool and update its status',
        description:
            'Answers 202 with the tool, `checking` while the call runs (or already settled when it was quick); ' +
            '`ai-tool.changed` follows when it ends. Idempotent while a check runs. It changes no credential, so ' +
            '`ai-tools.read` is enough; the engine rate-limits it, since each check is a model call.',
        permission: 'ai-tools.read',
        capability,
        params: AiToolParams,
        responses: { 202: oneTool },
        problems: ['ai-tool-not-installed'],
    }),
    startAiToolSignIn: defineRoute({
        id: 'startAiToolSignIn',
        method: 'POST',
        path: '/ai-tools/{aiToolId}/sign-ins',
        summary: 'Sign the tool in again, with the provider account or an API key; answers the first prompt',
        description:
            "The current credentials keep working until the new ones are verified. A method not in the tool's " +
            '`signInMethods` is 422 `ai-tool-method-unsupported`. Starting ends any earlier sign-in of the tool.',
        permission: 'ai-tools.manage',
        capability,
        params: AiToolParams,
        body: { kind: 'json', schema: StartAiToolSignInBody },
        responses: { 201: oneSignIn },
        problems: ['ai-tool-not-installed', 'ai-tool-method-unsupported'],
        stepUp: true,
    }),
    getAiToolSignIn: defineRoute({
        id: 'getAiToolSignIn',
        method: 'GET',
        path: '/ai-tools/{aiToolId}/sign-ins/{signInId}',
        summary: 'Get a sign-in this session started',
        description: 'Poll while `working`, or while a `harness-login` prompt is `waiting` or `verifying`.',
        permission: 'ai-tools.manage',
        capability,
        params: AiToolSignInParams,
        responses: { 200: oneSignIn },
    }),
    answerAiToolSignIn: defineRoute({
        id: 'answerAiToolSignIn',
        method: 'POST',
        path: '/ai-tools/{aiToolId}/sign-ins/{signInId}/answer',
        summary: "Answer the sign-in's prompt, or take one of its alternatives",
        description:
            'A `promptId` that is not the current prompt is 409 `ai-tool-sign-in-stale` and changes nothing. An ' +
            'answer of another kind than the prompt, or an alternative it does not offer without `href`, is 400 ' +
            '`validation-failed`. A key is verified with a real call before it replaces anything; it and any login ' +
            'code are never logged, audited, stored outside the engine’s credential store or sent back.',
        permission: 'ai-tools.manage',
        capability,
        params: AiToolSignInParams,
        body: { kind: 'json', schema: AnswerAiToolSignInBody },
        responses: { 200: oneSignIn },
        problems: ['ai-tool-sign-in-stale'],
    }),
    cancelAiToolSignIn: defineRoute({
        id: 'cancelAiToolSignIn',
        method: 'DELETE',
        path: '/ai-tools/{aiToolId}/sign-ins/{signInId}',
        summary: 'Abandon a sign-in; the tool keeps the credentials it had',
        permission: 'ai-tools.manage',
        capability,
        params: AiToolSignInParams,
        responses: { 204: { kind: 'empty' } },
    }),
    signOutAiTool: defineRoute({
        id: 'signOutAiTool',
        method: 'DELETE',
        path: '/ai-tools/{aiToolId}/credentials',
        summary: 'Sign the tool out on this project: its account sign-in or API key is removed from the engine',
        description:
            'Idempotent. The tool answers as `needs-sign-in` with `not-signed-in` afterwards, and work that runs on ' +
            'it fails with `ai-tool-sign-in-required` until it is signed in again.',
        permission: 'ai-tools.manage',
        capability,
        params: AiToolParams,
        responses: { 200: oneTool },
        problems: ['ai-tool-not-installed'],
        stepUp: true,
    }),
} as const;
