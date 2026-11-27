import { KNOWN_CAPABILITIES, supports } from '@ptbk/engine-api';
import type { CapabilityRef } from '@ptbk/engine-api';
import type { InMemoryEngineController } from '@ptbk/engine-api/in-memory';

/** What the seeded items link to: the scenario's first chat and task, when it has them. */
export interface NotificationRefs {
    readonly chatId?: string | undefined;
    readonly task?: { readonly id: string; readonly name: string } | undefined;
}

/**
 * A small inbox per member with content and links, so the engine UI has something real to show (`notifications@1`).
 * Deterministic: the same seed and scenario give the same items. Seeded members joined with no dashboard ticket, so
 * their items never reach the heartbeat; a project-wide sign-in item does, without `to`, and so do items raised later
 * (`POST /__mock/notifications`) for people who joined through the dashboard.
 */
export function seedNotifications(
    controller: InMemoryEngineController,
    capabilities: readonly CapabilityRef[],
    refs: NotificationRefs,
): void {
    if (!supports({ capabilities }, KNOWN_CAPABILITIES.notifications)) return;
    const snapshot = controller.inspect();
    const agent = snapshot.agents.find(({ deletedAt, origin }) => deletedAt === null && origin === 'content');
    const chat = agent === undefined || refs.chatId === undefined ? undefined : { agent, id: refs.chatId };
    const task = refs.task;
    const failedRun = controller.findRuns({ status: ['failed'] })[0];
    const members = snapshot.members.filter(({ status }) => status === 'active');
    for (const [index, member] of members.entries()) {
        if (chat !== undefined) {
            controller.raiseNotification({
                memberId: member.id,
                kind: 'agent-waiting',
                title: `${chat.agent.name} is waiting for your answer`,
                detail: 'It asks which of the two drafts to send to the client.',
                target: { kind: 'chat', agentId: chat.agent.id, chatId: chat.id },
            });
        }
        if (index === 0 && task !== undefined) {
            controller.raiseNotification({
                memberId: member.id,
                kind: 'task-failed',
                title: `“${task.name}” failed`,
                detail: 'The spreadsheet it reads from was moved. Retry once it is back.',
                target: { kind: 'task', taskId: task.id },
            });
        }
        if (index === 1 && failedRun !== undefined) {
            controller.raiseNotification({
                memberId: member.id,
                kind: 'task-failed',
                title: 'A run you started failed',
                detail: null,
                target: { kind: 'run', runId: failedRun.id },
            });
        }
    }
    const tool = supports({ capabilities }, KNOWN_CAPABILITIES.aiTools)
        ? controller.aiTools().find(({ status }) => status === 'needs-sign-in')
        : undefined;
    if (tool !== undefined) {
        controller.raiseNotification({
            memberId: null,
            kind: 'tool-sign-in',
            title: `${tool.name} needs signing in again`,
            detail: 'Chats that run on it wait until someone who manages the project signs it in.',
            target: { kind: 'ai-tool', aiToolId: tool.id },
        });
    }
}
