import { describe, expect, it } from 'vitest';

import { ChatRecheck } from '../chats';
import { ProblemDetails } from '../common';
import { EngineEvent, EngineEventReader } from '../events';
import { createProblem } from '../problem';
import {
    AiTool,
    AiToolListReader,
    AiToolReader,
    AiToolSignIn,
    AiToolSignInReader,
    AnswerAiToolSignInBody,
    StartAiToolSignInBody,
} from './ai-tools';

const SIGNED_IN = {
    id: 'claude-code',
    name: 'Claude Code',
    version: '2.1.330',
    auth: { method: 'account', account: 'Claude Max' },
    signInMethods: ['account', 'api-key'],
    checkedAt: '2026-11-24T09:00:00Z',
    checking: false,
    status: 'signed-in',
    problem: null,
} as const;

const SIGN_IN = {
    id: 'sign-in-1',
    aiToolId: 'claude-code',
    method: 'api-key',
    status: 'pending',
    activity: [],
    expiresAt: '2026-11-24T09:15:00Z',
    prompt: {
        id: 'prompt-1',
        kind: 'secret',
        title: 'Claude Code API key',
        question: 'Paste an Anthropic API key.',
        hint: null,
        error: null,
        canGoBack: false,
        details: [],
        alternatives: [],
        label: 'Anthropic API key',
        placeholder: null,
        helpUrl: 'https://console.anthropic.com/settings/keys',
    },
    tool: SIGNED_IN,
} as const;

describe('ai-tools@1 schemas', () => {
    it('has a problem exactly when a tool is not signed in', () => {
        expect(AiTool.safeParse(SIGNED_IN).success).toBe(true);
        expect(AiTool.safeParse({ ...SIGNED_IN, status: 'needs-sign-in' }).success).toBe(false);
        expect(
            AiTool.safeParse({ ...SIGNED_IN, problem: { code: 'quota-exceeded', message: 'Out of credit.' } }).success,
        ).toBe(false);
        expect(
            AiTool.safeParse({
                ...SIGNED_IN,
                status: 'error',
                problem: { code: 'quota-exceeded', message: 'Out of credit.' },
            }).success,
        ).toBe(true);
    });

    it('refuses what an engine must never send: unknown fields, repeated methods, a key-shaped field', () => {
        expect(AiTool.safeParse({ ...SIGNED_IN, apiKey: 'sk-ant-x' }).success).toBe(false);
        expect(AiTool.safeParse({ ...SIGNED_IN, auth: { method: 'api-key', account: null, key: 'x' } }).success).toBe(
            false,
        );
        expect(AiTool.safeParse({ ...SIGNED_IN, signInMethods: ['account', 'account'] }).success).toBe(false);
    });

    it('reads a newer engine tolerantly: unknown statuses, methods and problem codes, extra fields', () => {
        const read = AiToolReader.parse({
            ...SIGNED_IN,
            status: 'updating',
            auth: { method: 'sso', account: null },
            signInMethods: ['account', 'sso'],
            problem: { code: 'license-missing', message: 'No seat.' },
            extra: true,
        });
        expect(read).toMatchObject({
            status: 'unknown',
            auth: { method: 'unknown' },
            signInMethods: ['account', 'unknown'],
            problem: { code: 'unknown' },
        });
        expect(read).not.toHaveProperty('extra');
        expect(AiToolListReader.parse({ items: [SIGNED_IN] }).items).toHaveLength(1);
    });

    it('reuses the onboarding prompts and reads an unknown prompt kind as unsupported', () => {
        expect(AiToolSignIn.safeParse(SIGN_IN).success).toBe(true);
        expect(AiToolSignIn.safeParse({ ...SIGN_IN, prompt: { ...SIGN_IN.prompt, kind: 'text' } }).success).toBe(false);
        const read = AiToolSignInReader.parse({
            ...SIGN_IN,
            prompt: { id: 'prompt-2', kind: 'qr-login', title: 'Scan', question: 'Scan the code.' },
        });
        expect(read.prompt).toMatchObject({ kind: 'unsupported', engineKind: 'qr-login' });
    });

    it('takes exactly a secret or a returned code as an answer, and a method to start with', () => {
        expect(
            AnswerAiToolSignInBody.safeParse({
                promptId: 'p',
                action: 'answer',
                answer: { kind: 'secret', value: 'sk-ant-key' },
            }).success,
        ).toBe(true);
        expect(
            AnswerAiToolSignInBody.safeParse({
                promptId: 'p',
                action: 'answer',
                answer: { kind: 'text', text: 'x', fileIds: [] },
            }).success,
        ).toBe(false);
        expect(AnswerAiToolSignInBody.safeParse({ promptId: 'p', action: 'back' }).success).toBe(false);
        expect(StartAiToolSignInBody.safeParse({ method: 'api-key' }).success).toBe(true);
        expect(StartAiToolSignInBody.safeParse({ method: 'api-key', key: 'x' }).success).toBe(false);
    });

    it('names the tool to sign in again in the problem and the recheck, and announces changes', () => {
        const problem = createProblem('ai-tool-sign-in-required', { aiToolId: 'codex' as never });
        expect(ProblemDetails.parse(problem)).toMatchObject({ status: 503, aiToolId: 'codex' });
        expect(ChatRecheck.parse({ cause: 'Failed.', nextAt: '2026-11-24T09:00:00Z', rounds: 1 }).aiToolId).toBeNull();
        expect(EngineEvent.parse({ type: 'ai-tool.changed', aiToolId: 'codex' })).toBeTruthy();
        expect(EngineEventReader.parse({ type: 'ai-tool.changed', aiToolId: 'codex' })).toEqual({
            type: 'ai-tool.changed',
            aiToolId: 'codex',
        });
    });
});
