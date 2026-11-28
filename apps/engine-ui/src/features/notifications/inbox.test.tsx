import { KNOWN_CAPABILITIES, NotificationId, OWNER_PERMISSIONS } from '@ptbk/engine-api';
import type { EngineApiClient, Permission } from '@ptbk/engine-api';
import { createInMemoryEngine, DEFAULT_CAPABILITIES } from '@ptbk/engine-api/in-memory';
import type { InMemoryEngineController } from '@ptbk/engine-api/in-memory';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';
import { createSecurityEngine, OWNER_ID } from '../../testing/security-engine';
import { problemResponse, TEST_NOW } from '../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;
const HOSTILE = '<img src=x onerror=alert(1)>';

function raiseEveryKind(controller: InMemoryEngineController, memberId = OWNER_ID) {
    return [
        controller.raiseNotification({
            memberId,
            kind: 'agent-waiting',
            title: `Ada asks: ${HOSTILE}`,
            detail: `Line one ${HOSTILE}\nLine two`,
            target: { kind: 'chat', agentId: 'agent-ada', chatId: 'chat-1' },
        }),
        controller.raiseNotification({
            memberId,
            kind: 'task-failed',
            title: 'Weekly report failed',
            target: { kind: 'task', taskId: 'task-1' },
        }),
        controller.raiseNotification({
            memberId,
            kind: 'task-failed',
            title: 'Run stopped',
            target: { kind: 'run', runId: 'run-1' },
        }),
        controller.raiseNotification({
            memberId: null,
            kind: 'tool-sign-in',
            title: 'Claude Code needs signing in again',
            target: { kind: 'ai-tool', aiToolId: 'claude-code' },
        }),
        controller.raiseNotification({ memberId, kind: 'agent-waiting', title: 'Nothing to open', target: null }),
    ];
}

/** As if the member had seen the item on an earlier visit. */
async function markSeenNow(client: EngineApiClient, id: string | undefined): Promise<void> {
    await client.notifications.markSeen({ ids: [NotificationId.parse(id)] }, AbortSignal.timeout(1_000));
}

function engineWithout(capability: (typeof KNOWN_CAPABILITIES)[keyof typeof KNOWN_CAPABILITIES]) {
    return createInMemoryEngine({
        clock: { now: () => TEST_NOW },
        capabilities: DEFAULT_CAPABILITIES.filter((ref) => ref !== capability),
        seed: { engine: { name: 'Test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' } },
    });
}

const nav = () => screen.getByRole('navigation', { name: 'Main' });
const inboxList = () => screen.findByRole('list', { name: 'Notifications' });

describe('inbox: gating and badge', { timeout: TIMEOUT_MS }, () => {
    it('shows nothing on a project without notifications@1', async () => {
        const engine = engineWithout(KNOWN_CAPABILITIES.notifications);
        const counts = vi.spyOn(engine.client.notifications, 'counts');
        renderWithProviders({ path: '/settings', engineApi: engine.client });
        expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeDefined();
        expect(within(nav()).queryByRole('link', { name: /Inbox/ })).toBeNull();
        expect(screen.queryByRole('switch', { name: /how many things wait/ })).toBeNull();
        expect(counts).not.toHaveBeenCalled();
    });

    it('says the inbox is not available when opened directly without the capability', async () => {
        renderWithProviders({ path: '/inbox', engineApi: engineWithout(KNOWN_CAPABILITIES.notifications).client });
        expect(await screen.findByText(/not available/i)).toBeDefined();
    });

    it('counts the unseen items, project-wide ones included for the owner', async () => {
        const engine = createSecurityEngine();
        const [first] = raiseEveryKind(engine.controller);
        await markSeenNow(engine.client, first?.id);
        renderWithProviders({ path: '/settings', engineApi: engine.client });
        const link = await within(nav()).findByRole('link', { name: /Inbox/ });
        await waitFor(() => {
            expect(within(link).getByText('4 waiting')).toBeDefined();
        });
    });

    it('shows no badge when nothing waits', async () => {
        renderWithProviders({ path: '/settings', engineApi: createSecurityEngine().client });
        const link = await within(nav()).findByRole('link', { name: /Inbox/ });
        expect(link.textContent).toBe('Inbox');
    });
});

describe('inbox: the list', { timeout: TIMEOUT_MS }, () => {
    it('renders titles and details as text, never as markup', async () => {
        const engine = createSecurityEngine();
        raiseEveryKind(engine.controller);
        const { container } = renderWithProviders({ path: '/inbox', engineApi: engine.client });
        const list = await inboxList();
        expect(within(list).getByRole('link', { name: `Ada asks: ${HOSTILE}` })).toBeDefined();
        expect(within(list).getByText(/Line one <img src=x onerror=alert\(1\)>/)).toBeDefined();
        expect(container.querySelector('img')).toBeNull();
        expect(container.querySelector('[onerror]')).toBeNull();
        await expectNoAxeViolations(container);
    });

    it('lists newest first with the kind, the project marker and how long ago', async () => {
        const engine = createSecurityEngine();
        raiseEveryKind(engine.controller);
        renderWithProviders({ path: '/inbox', engineApi: engine.client });
        const items = within(await inboxList()).getAllByRole('listitem');
        expect(items).toHaveLength(5);
        const tool = items.find((item) => item.textContent.includes('Claude Code needs signing in again'));
        expect(tool === undefined ? null : within(tool).getByText('For the project')).not.toBeNull();
        expect(tool === undefined ? null : within(tool).getByText('AI tool needs signing in')).not.toBeNull();
        expect(within(items[0] as HTMLElement).getByText('New')).toBeDefined();
        expect(items.every((item) => item.querySelector('time') !== null)).toBe(true);
        const personal = items.filter((item) => !item.textContent.includes('For the project'));
        expect(personal).toHaveLength(4);
    });

    it('links each item to where it is handled, and a missing target nowhere', async () => {
        const engine = createSecurityEngine();
        raiseEveryKind(engine.controller);
        renderWithProviders({ path: '/inbox', engineApi: engine.client });
        const list = await inboxList();
        const href = (name: string | RegExp) => within(list).getByRole('link', { name }).getAttribute('href');
        expect(href(/^Ada asks/)).toBe('/chats/chat-1');
        expect(href('Weekly report failed')).toBe('/tasks/task-1');
        expect(href('Run stopped')).toBe('/runs/run-1');
        expect(href('Claude Code needs signing in again')).toBe('/settings/ai-tools?signIn=claude-code');
        expect(within(list).getByText('Nothing to open').closest('a')).toBeNull();
    });

    it('does not link to what the member may not open', async () => {
        const permissions: readonly Permission[] = OWNER_PERMISSIONS.filter(
            (permission) => permission !== 'runs.read' && permission !== 'tasks.read',
        );
        const engine = createSecurityEngine({ permissions });
        raiseEveryKind(engine.controller);
        renderWithProviders({ path: '/inbox', engineApi: engine.client });
        const list = await inboxList();
        expect(within(list).getByText('Run stopped').closest('a')).toBeNull();
        expect(within(list).getByText('Weekly report failed').closest('a')).toBeNull();
        expect(within(list).getByRole('link', { name: /^Ada asks/ })).toBeDefined();
    });

    it('says calmly when nothing waits', async () => {
        renderWithProviders({ path: '/inbox', engineApi: createSecurityEngine().client });
        expect(await screen.findByRole('heading', { name: 'Nothing waits for you' })).toBeDefined();
    });

    it('pages with Show more and marks every page it shows', async () => {
        const engine = createSecurityEngine();
        for (let index = 0; index < 55; index += 1) {
            engine.controller.raiseNotification({
                memberId: OWNER_ID,
                kind: 'task-failed',
                title: `Item ${String(index)}`,
            });
        }
        const markSeen = vi.spyOn(engine.client.notifications, 'markSeen');
        const { user } = renderWithProviders({ path: '/inbox', engineApi: engine.client });
        const list = await inboxList();
        expect(within(list).getAllByRole('listitem')).toHaveLength(50);
        await user.click(screen.getByRole('button', { name: 'Show more' }));
        await waitFor(() => {
            expect(within(list).getAllByRole('listitem')).toHaveLength(55);
        });
        expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
        await waitFor(() => {
            expect(markSeen).toHaveBeenCalledTimes(2);
        });
        expect(markSeen.mock.calls.map(([body]) => body.ids.length)).toEqual([50, 5]);
    });
});

describe('inbox: seen on view', { timeout: TIMEOUT_MS }, () => {
    it('marks the unseen items it shows in one request and clears the badge', async () => {
        const engine = createSecurityEngine();
        const raised = raiseEveryKind(engine.controller);
        const markSeen = vi.spyOn(engine.client.notifications, 'markSeen');
        renderWithProviders({ path: '/inbox', engineApi: engine.client });
        await inboxList();
        await waitFor(() => {
            expect(markSeen).toHaveBeenCalledTimes(1);
        });
        expect([...(markSeen.mock.calls[0]?.[0].ids ?? [])].sort()).toEqual(raised.map(({ id }) => id).sort());
        await waitFor(() => {
            expect(within(nav()).getByRole('link', { name: /Inbox/ }).textContent).toBe('Inbox');
        });
        // What was new stays marked for this visit.
        expect(within(await inboxList()).getAllByText('New')).toHaveLength(5);
    });

    it('marks only what is still unseen, and nothing once all of it was seen', async () => {
        const engine = createSecurityEngine();
        const [seen, unseen] = raiseEveryKind(engine.controller);
        await markSeenNow(engine.client, seen?.id);
        const markSeen = vi.spyOn(engine.client.notifications, 'markSeen');
        const first = renderWithProviders({ path: '/inbox', engineApi: engine.client });
        await inboxList();
        await waitFor(() => {
            expect(markSeen).toHaveBeenCalledTimes(1);
        });
        expect(markSeen.mock.calls[0]?.[0].ids).toContain(unseen?.id);
        expect(markSeen.mock.calls[0]?.[0].ids).not.toContain(seen?.id);
        first.unmount();

        renderWithProviders({ path: '/inbox', engineApi: engine.client });
        expect(within(await inboxList()).queryByText('New')).toBeNull();
        expect(markSeen).toHaveBeenCalledTimes(1);
    });

    it('reads the inbox again when an item closed meanwhile, then marks the rest', async () => {
        const engine = createSecurityEngine();
        const [gone, ...rest] = raiseEveryKind(engine.controller);
        const markSeen = vi.spyOn(engine.client.notifications, 'markSeen').mockImplementationOnce(() => {
            engine.controller.closeNotification(gone?.id ?? '');
            return problemResponse('not-found');
        });
        renderWithProviders({ path: '/inbox', engineApi: engine.client });
        const list = await inboxList();
        await waitFor(() => {
            expect(markSeen).toHaveBeenCalledTimes(2);
        });
        expect([...(markSeen.mock.calls[1]?.[0].ids ?? [])].sort()).toEqual(rest.map(({ id }) => id).sort());
        await waitFor(() => {
            expect(within(list).queryByText(/^Ada asks/)).toBeNull();
        });
        await waitFor(() => {
            expect(within(nav()).getByRole('link', { name: /Inbox/ }).textContent).toBe('Inbox');
        });
    });
});

describe('settings: the owner’s attention switch', { timeout: TIMEOUT_MS }, () => {
    const toggle = () => screen.findByRole('switch', { name: 'Tell app.ptbk.io how many things wait for each person' });

    it('is on by default and turns off, so the heartbeat leaves the counts out', async () => {
        const engine = createSecurityEngine();
        raiseEveryKind(engine.controller);
        const { user, container } = renderWithProviders({ path: '/settings', engineApi: engine.client });
        const control = await toggle();
        expect((control as HTMLInputElement).checked).toBe(true);
        expect(screen.getByText(/^On: people hear by email/)).toBeDefined();
        expect(screen.getByText(/off by default in strict mode/)).toBeDefined();
        expect(screen.getByRole('link', { name: 'See the last heartbeat' }).getAttribute('href')).toBe(
            '/security#security-heartbeat',
        );
        await expectNoAxeViolations(container);

        await user.click(control);
        expect(await screen.findByText('Notifications now stay in this project')).toBeDefined();
        await waitFor(() => {
            expect(screen.getByRole<HTMLInputElement>('switch', { name: /how many things wait/ }).checked).toBe(false);
        });
        expect(screen.getByText(/^Off: notifications stay in this project/)).toBeDefined();
        expect(engine.controller.attention()).toBeNull();

        await user.click(await toggle());
        expect(await screen.findByText('app.ptbk.io now learns how many things wait')).toBeDefined();
        await waitFor(() => {
            expect(engine.controller.attention()).not.toBeNull();
        });
    });

    it('shows a switch that starts off as off', async () => {
        const engine = createSecurityEngine({
            seed: {
                settings: {
                    name: 'Test engine',
                    defaultAgentVisibility: 'private',
                    updatePolicy: { policy: 'auto', pinnedVersion: null },
                    dashboardAttention: false,
                },
            },
        });
        renderWithProviders({ path: '/settings', engineApi: engine.client });
        expect(((await toggle()) as HTMLInputElement).checked).toBe(false);
    });

    it('asks for a fresh passkey before changing it', async () => {
        const engine = createSecurityEngine({ stepUp: 'required' });
        const { user } = renderWithProviders({ path: '/settings', engineApi: engine.client });
        await user.click(await toggle());
        expect(await screen.findByRole('dialog', { name: 'Confirm it is you' })).toBeDefined();
        await waitFor(() => {
            expect(screen.getByRole<HTMLInputElement>('switch', { name: /how many things wait/ }).checked).toBe(true);
        });
        expect(engine.controller.attention()).not.toBeNull();
    });

    it('is not offered without settings.manage, while the inbox still is', async () => {
        const permissions = OWNER_PERMISSIONS.filter((permission) => permission !== 'settings.manage');
        renderWithProviders({ path: '/settings', engineApi: createSecurityEngine({ permissions }).client });
        expect(await within(nav()).findByRole('link', { name: /Inbox/ })).toBeDefined();
        expect(screen.queryByRole('switch', { name: /how many things wait/ })).toBeNull();
    });
});
