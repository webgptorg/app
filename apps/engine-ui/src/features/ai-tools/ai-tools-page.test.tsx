import { KNOWN_CAPABILITIES, OWNER_PERMISSIONS } from '@ptbk/engine-api';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';
import { createSecurityEngine, documentText } from '../../testing/security-engine';

const TIMEOUT_MS = 20_000;
const ANTHROPIC_KEY = 'sk-ant-test-not-a-real-key-0000000000';

function renderPage(options: Parameters<typeof createSecurityEngine>[0] = {}, path = '/settings/ai-tools') {
    const engine = createSecurityEngine(options);
    return { ...renderWithProviders({ path, engineApi: engine.client }), engine };
}

const row = async (name: string) => (await screen.findByText(name, { selector: 'span' })).closest('li') as HTMLElement;

describe('AI tools', { timeout: TIMEOUT_MS }, () => {
    it('lists each tool with its status, how it signs in and when it was checked', async () => {
        const { container } = renderPage();
        const claude = await row('Claude Code');
        expect(within(claude).getByText('Ready')).toBeDefined();
        expect(within(claude).getByText('Signed in as Claude Max')).toBeDefined();
        expect(within(await row('OpenAI Codex')).getByText('Uses an API key')).toBeDefined();
        const gemini = await row('Gemini CLI');
        expect(within(gemini).getByText('Not installed')).toBeDefined();
        expect(within(gemini).queryByRole('button', { name: 'Check now' })).toBeNull();
        expect(screen.getByText(/Promptbook never sees them/)).toBeDefined();
        await expectNoAxeViolations(container);
    });

    it('checks a tool now and says so as a warning when the check finds a problem', async () => {
        const { user, engine } = renderPage();
        await user.click(within(await row('Claude Code')).getByRole('button', { name: 'Check now' }));
        expect(await screen.findByText('Claude Code works.')).toBeDefined();
        engine.controller.failAiToolCheck('codex', { code: 'quota-exceeded', message: 'You exceeded your quota.' });
        await user.click(within(await row('OpenAI Codex')).getByRole('button', { name: 'Check now' }));
        expect(await screen.findByText('OpenAI Codex needs attention.')).toBeDefined();
        const codex = await row('OpenAI Codex');
        await waitFor(() => {
            expect(within(codex).getByText('Out of quota or credit.')).toBeDefined();
        });
        expect(within(codex).getByText('You exceeded your quota.')).toBeDefined();
    });

    it('signs an expired tool in again with a returned code, from the shared onboarding form', async () => {
        const { user, engine } = renderPage();
        engine.controller.expireAiToolSignIn('claude-code');
        const claude = await row('Claude Code');
        await user.click(await within(claude).findByRole('button', { name: 'Sign in again' }));
        const dialog = await screen.findByRole('dialog', { name: 'Sign in to Claude Code' });
        expect(within(dialog).getByText(/Open the Claude Code sign-in page/)).toBeDefined();
        await user.type(await within(dialog).findByRole('textbox'), 'code#123456');
        await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
        expect(await screen.findByText('Claude Code signed in.')).toBeDefined();
        await waitFor(() => {
            expect(screen.queryByRole('dialog')).toBeNull();
        });
        await waitFor(() => {
            expect(within(claude).getByText('Ready')).toBeDefined();
        });
    });

    it('takes an API key instead without ever showing or keeping it', async () => {
        const { user } = renderPage();
        await user.click(
            within(await row('Claude Code')).getByRole('button', { name: 'More actions for Claude Code' }),
        );
        await user.click(await screen.findByRole('menuitem', { name: 'Use an API key' }));
        const dialog = await screen.findByRole('dialog', { name: 'Sign in to Claude Code' });
        const field = await within(dialog).findByLabelText('Anthropic API key');
        await user.type(field, 'sk-ant-short');
        await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
        expect(await within(dialog).findByText(/did not accept this key/)).toBeDefined();
        await user.type(await within(dialog).findByLabelText('Anthropic API key'), ANTHROPIC_KEY);
        await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
        expect(await screen.findByText('Claude Code signed in.')).toBeDefined();
        expect(documentText()).not.toContain(ANTHROPIC_KEY);
        expect(within(await row('Claude Code')).getByText('Uses an API key')).toBeDefined();
    });

    it('signs a tool out from the overflow menu after confirming', async () => {
        const { user } = renderPage();
        await user.click(
            within(await row('OpenAI Codex')).getByRole('button', { name: 'More actions for OpenAI Codex' }),
        );
        await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
        const confirm = await screen.findByRole('dialog', { name: 'Sign OpenAI Codex out?' });
        await user.click(within(confirm).getByRole('button', { name: 'Sign out' }));
        expect(await screen.findByText('OpenAI Codex signed out.')).toBeDefined();
        await waitFor(async () => {
            expect(within(await row('OpenAI Codex')).getByText('Needs sign-in')).toBeDefined();
        });
    });

    it('opens the sign-in a link asks for, the way the tool signed in before', async () => {
        renderPage({}, '/settings/ai-tools?signIn=codex');
        const dialog = await screen.findByRole('dialog', { name: 'Sign in to OpenAI Codex' });
        expect(await within(dialog).findByLabelText('OpenAI API key')).toBeDefined();
    });

    it('shows admins the tools without any way to sign them in or out', async () => {
        const { user } = renderPage({ permissions: OWNER_PERMISSIONS.filter((p) => p !== 'ai-tools.manage') });
        const claude = await row('Claude Code');
        expect(within(claude).getByRole('button', { name: 'Check now' })).toBeDefined();
        expect(within(claude).queryByRole('button', { name: /More actions/ })).toBeNull();
        await user.click(within(claude).getByRole('button', { name: 'Check now' }));
        expect(await screen.findByText('Claude Code works.')).toBeDefined();
    });

    it('is not there on a project without the capability', async () => {
        renderWithProviders({
            path: '/settings/ai-tools',
            capabilities: Object.values(KNOWN_CAPABILITIES).filter((ref) => ref !== KNOWN_CAPABILITIES.aiTools),
        });
        expect(await screen.findByText(/not available/i)).toBeDefined();
    });

    it('asks for a sign-in on Home', async () => {
        const engine = createSecurityEngine();
        engine.controller.expireAiToolSignIn('claude-code');
        const { user } = renderWithProviders({ path: '/', engineApi: engine.client });
        expect(await screen.findByText('1 AI tool needs signing in')).toBeDefined();
        await user.click(screen.getByRole('link', { name: 'Review' }));
        expect(await screen.findByRole('heading', { level: 1, name: 'AI tools' })).toBeDefined();
    });

    it('offers the sign-in on a chat reply that failed for it, to the owner only', async () => {
        const seed = {
            chats: [
                {
                    id: 'chat-tools',
                    createdAt: '2026-11-24T08:00:00Z',
                    entries: [
                        { type: 'message' as const, author: { kind: 'user' as const, key: 'user' }, content: 'Hi' },
                        { type: 'joined' as const, participant: { kind: 'agent' as const, key: 'agent-ada' } },
                    ],
                    recheck: {
                        cause: 'Claude Code needs signing in again before agents can answer.',
                        nextAt: '2030-01-01T00:00:00Z',
                        rounds: 1,
                        author: { kind: 'agent' as const, key: 'agent-ada' },
                        aiToolId: 'claude-code',
                    },
                },
            ],
        };
        const owner = renderWithProviders({
            path: '/chats/chat-tools',
            engineApi: createSecurityEngine({ seed }).client,
        });
        const link = await screen.findByRole('link', { name: 'Sign in again' });
        expect(link.getAttribute('href')).toBe('/settings/ai-tools?signIn=claude-code');
        owner.unmount();

        renderWithProviders({
            path: '/chats/chat-tools',
            engineApi: createSecurityEngine({
                seed,
                permissions: OWNER_PERMISSIONS.filter((p) => p !== 'ai-tools.manage'),
            }).client,
        });
        expect(await screen.findByText(/project owner can sign it in again/)).toBeDefined();
        expect(screen.queryByRole('link', { name: 'Sign in again' })).toBeNull();
    });
});
