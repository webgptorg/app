import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { AnswerOnboardingBody, EngineApiResponse, OnboardingPrompt, ReadOnboardingState } from '@ptbk/engine-api';
import { createInMemoryEngine } from '@ptbk/engine-api/in-memory';
import { focusManager } from '@tanstack/react-query';
import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '../../testing/render-with-providers';
import { problemResponse, TEST_NOW } from '../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;

const base = { hint: null, error: null, canGoBack: true, details: [], alternatives: [] };

const HARNESSES: OnboardingPrompt = {
    ...base,
    id: 'p-harnesses',
    kind: 'choice',
    title: 'Harnesses',
    question: 'Which harnesses should run this project?',
    multiple: true,
    choices: [
        { id: 'claude-code', label: 'Claude Code', description: null, disabled: false },
        { id: 'openai-codex', label: 'OpenAI Codex', description: null, disabled: false },
        { id: 'gemini-cli', label: 'Gemini CLI', description: null, disabled: false },
    ],
    initial: ['claude-code'],
};

const NAME: OnboardingPrompt = {
    ...base,
    id: 'p-name',
    kind: 'text',
    title: 'Project name',
    question: 'What should this project be called?',
    multiline: false,
    required: true,
    placeholder: null,
    initial: 'My project',
    attachments: false,
};

function pending(prompt: OnboardingPrompt): ReadOnboardingState {
    return { status: 'pending', deferred: false, canDefer: false, progress: null, activity: [], prompt };
}

/**
 * An engine whose reads can be held, as over a slow relay: a read that leaves before an answer comes back after it,
 * carrying the state from before the answer.
 */
function slowEngine() {
    const engine = createInMemoryEngine({
        clock: { now: () => TEST_NOW },
        seed: { engine: { name: 'Test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' } },
        capabilities: [KNOWN_CAPABILITIES.files, KNOWN_CAPABILITIES.onboarding],
    });
    let current = pending(HARNESSES);
    const held: (() => void)[] = [];
    let holdReads = false;
    const bodies: AnswerOnboardingBody[] = [];
    const client = {
        ...engine.client,
        onboarding: {
            ...engine.client.onboarding,
            get: (): Promise<EngineApiResponse<ReadOnboardingState>> => {
                const answer = { kind: 'ok' as const, data: current };
                if (!holdReads) return Promise.resolve(answer);
                return new Promise((resolve) => {
                    held.push(() => {
                        resolve(answer);
                    });
                });
            },
            answer: (body: AnswerOnboardingBody): Promise<EngineApiResponse<ReadOnboardingState>> => {
                bodies.push(body);
                if (body.promptId !== current.prompt?.id) return problemResponse('onboarding-prompt-stale');
                current = pending(NAME);
                return Promise.resolve({ kind: 'ok', data: current });
            },
        },
    };
    return {
        client,
        bodies,
        /** The engine moves on by itself, e.g. its own job sends the member back to a step. */
        moveTo: (prompt: OnboardingPrompt) => {
            current = pending(prompt);
        },
        holdReads: () => {
            holdReads = true;
        },
        releaseReads: () => {
            const released = held.splice(0);
            for (const release of released) release();
            return released.length;
        },
    };
}

describe('onboarding answers and reads in flight', { timeout: TIMEOUT_MS }, () => {
    it('never puts an answered prompt back when a read that left before the answer lands after it', async () => {
        const engine = slowEngine();
        const { user } = renderWithProviders({ path: '/onboarding', engineApi: engine.client });
        const claude = await screen.findByRole<HTMLInputElement>('checkbox', { name: 'Claude Code' });
        expect(claude.checked).toBe(true);

        // Coming back to the tab reads the state again; over the relay that read is still on its way.
        engine.holdReads();
        act(() => {
            focusManager.setFocused(false);
            focusManager.setFocused(true);
        });

        await user.click(claude);
        await user.click(screen.getByRole('checkbox', { name: 'Gemini CLI' }));
        expect(claude.checked).toBe(false);
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        expect(await screen.findByRole('heading', { level: 1, name: 'Project name' })).toBeDefined();
        expect(engine.bodies).toEqual([
            { promptId: 'p-harnesses', action: 'answer', answer: { kind: 'choice', choiceIds: ['gemini-cli'] } },
        ]);

        await act(async () => {
            expect(engine.releaseReads()).toBe(1);
            await new Promise((resolve) => setTimeout(resolve, 50));
        });
        expect(screen.getByRole('heading', { level: 1, name: 'Project name' })).toBeDefined();
        expect(screen.queryByRole('checkbox', { name: 'Claude Code' })).toBeNull();
    });

    it('reads the state again on an engine in setup only, when the engine moved past the answered prompt', async () => {
        const engine = slowEngine();
        const { user } = renderWithProviders({ path: '/onboarding', engineApi: engine.client });
        await user.click(await screen.findByRole('checkbox', { name: 'Gemini CLI' }));
        engine.moveTo(NAME);
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        expect(await screen.findByRole('heading', { level: 1, name: 'Project name' })).toBeDefined();
    });

    it('keeps what the member picked when the engine sends the same prompt again', async () => {
        const engine = slowEngine();
        const { user, queryClient } = renderWithProviders({ path: '/onboarding', engineApi: engine.client });
        const claude = await screen.findByRole<HTMLInputElement>('checkbox', { name: 'Claude Code' });
        await user.click(claude);
        await user.click(screen.getByRole('checkbox', { name: 'Gemini CLI' }));
        await act(async () => {
            await queryClient.refetchQueries({ queryKey: ['onboarding'] });
        });
        expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Claude Code' }).checked).toBe(false);
        expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Gemini CLI' }).checked).toBe(true);
    });
});
