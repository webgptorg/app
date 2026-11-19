import { ENGINE_API_PREFIX, KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { Page } from '@playwright/test';

import { routeFakeEngineApi } from './fake-engine-api.ts';

/** Engine text that must stay text wherever setup shows it. */
export const HOSTILE_SETUP_TEXT = '<img src=x onerror=alert(1)> <script>alert(1)</script>';

const prompt = { hint: null, error: null, canGoBack: true, details: [], alternatives: [] };

const state = (fields: Record<string, unknown>) => ({
    status: 'pending',
    deferred: false,
    canDefer: false,
    progress: null,
    activity: [],
    prompt: null,
    ...fields,
});

const ACTIVITY = [
    { id: 'install-codex', label: 'Install OpenAI Codex', status: 'done', detail: null },
    {
        id: 'check-claude',
        label: 'Check Claude Code',
        status: 'failed',
        detail: 'claude exited with code 127: command not found',
    },
    { id: 'install-gemini', label: 'Install Gemini CLI', status: 'skipped', detail: null },
    { id: 'project', label: 'Prepare the project folder', status: 'running', detail: null },
];

/**
 * A paired engine without a project, as an engine would serve it, one state per step: Reborn's App flow with every
 * kind and field `onboarding@1` added for setup in the browser. Each answer, back or alternative moves on by one.
 */
export const SETUP_SCRIPT: readonly Record<string, unknown>[] = [
    state({
        status: 'working',
        progress: { step: 2, of: 6 },
        activity: ACTIVITY,
    }),
    state({
        progress: { step: 3, of: 6 },
        activity: ACTIVITY.slice(0, 3),
        prompt: {
            ...prompt,
            id: 'login-codex',
            kind: 'harness-login',
            title: 'Sign in to OpenAI Codex',
            question: 'Sign in with your ChatGPT account so your agents can use Codex.',
            harness: 'OpenAI Codex',
            method: 'device-code',
            url: 'https://auth.openai.com/codex/device',
            userCode: 'K7QF-3MRP',
            status: 'waiting',
            diagnostic: null,
            expiresAt: null,
            alternatives: [
                {
                    id: 'api-key',
                    label: 'Use an API key instead',
                    description: 'For an organisation or project key from platform.openai.com.',
                    href: null,
                },
                {
                    id: 'terminal',
                    label: 'Sign in in a terminal instead',
                    description: 'The engine’s own terminal, with the Codex sign-in already started.',
                    href: '/_ptbk/harness-terminal?harness=codex',
                },
            ],
        },
    }),
    state({
        progress: { step: 3, of: 6 },
        prompt: {
            ...prompt,
            id: 'key-1',
            kind: 'secret',
            title: 'OpenAI API key',
            question: 'Paste an OpenAI API key for Codex.',
            hint: 'It starts with sk-.',
            label: 'OpenAI API key',
            placeholder: 'sk-…',
            helpUrl: 'https://platform.openai.com/api-keys',
        },
    }),
    state({
        progress: { step: 3, of: 6 },
        prompt: {
            ...prompt,
            id: 'key-2',
            kind: 'secret',
            title: 'OpenAI API key',
            question: 'Paste an OpenAI API key for Codex.',
            hint: 'It starts with sk-.',
            error: 'OpenAI did not accept this key. Check that it is active and paste it again.',
            label: 'OpenAI API key',
            placeholder: 'sk-…',
            helpUrl: 'https://platform.openai.com/api-keys',
        },
    }),
    state({
        progress: { step: 6, of: 6 },
        prompt: {
            ...prompt,
            id: 'review',
            kind: 'confirm',
            title: 'Review',
            question: 'Create the project and start your agents?',
            details: [
                { label: 'Project', text: HOSTILE_SETUP_TEXT },
                { label: 'Folder', text: '/home/ada/projects/bakery' },
                { label: 'AI tools', text: 'OpenAI Codex (API key)' },
                { label: 'What you are working on', text: 'Books and orders for a small bakery.\nTwo shops.' },
            ],
            confirmLabel: 'Create and start',
            declineLabel: 'Change something',
        },
    }),
    state({
        prompt: {
            id: 'profile',
            kind: 'browser-profile',
            title: 'Browser profile',
            question: 'Which browser profile should your agents use?',
        },
    }),
];

/**
 * Serves `script` as the engine's onboarding over the fake engine API, which advertises only what a paired engine
 * without a project does. Returns the request bodies the UI sent.
 */
export async function routeSetupScript(
    page: Page,
    script: readonly Record<string, unknown>[] = SETUP_SCRIPT,
    start = 0,
): Promise<unknown[]> {
    await routeFakeEngineApi(page, { capabilities: [KNOWN_CAPABILITIES.files, KNOWN_CAPABILITIES.onboarding] });
    let index = start;
    const bodies: unknown[] = [];
    const current = () => script[Math.min(index, script.length - 1)];
    await page.route(`**${ENGINE_API_PREFIX}/onboarding`, (route) => route.fulfill({ json: current() }));
    await page.route(`**${ENGINE_API_PREFIX}/onboarding/answer`, (route) => {
        bodies.push(route.request().postDataJSON());
        index++;
        return route.fulfill({ json: current() });
    });
    return bodies;
}
