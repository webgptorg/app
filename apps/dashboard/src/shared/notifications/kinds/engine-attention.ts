import { m } from '../../../paraglide/messages';
import {
    DAY_MS,
    defineEngineKind,
    UNSEEN_EMAIL_DELAY_MS,
    type ChannelDefaults,
    type EngineKind,
    type NotificationCopy,
} from '../notification-kind';

/**
 * What the engine counts in its heartbeat's `attention` (ADR 0027): how many open items of a kind someone has not yet
 * seen in the engine UI. Never what they are: the engine UI shows them, with their content, on its own origin. A count
 * that persists is the engine saying they are still unseen, so seeing the bell does not hold back the email.
 */
function attentionKind<K extends string>(
    id: K,
    defaults: ChannelDefaults,
    copy: Omit<NotificationCopy<never>, 'link'>,
): EngineKind<K> {
    return defineEngineKind({
        id,
        source: 'engine',
        reach: 'managers-or-approved',
        variants: [],
        defaults,
        timing: {
            emailDelayMs: UNSEEN_EMAIL_DELAY_MS,
            hourlyCap: true,
            closesWhenSeen: () => false,
            // The status object writes only on a change, so a steady count is not touched for weeks.
            lifetimeMs: 30 * DAY_MS,
        },
        copy: { ...copy, link: () => ({ to: 'project', path: '/' }) },
    });
}

const EVERYONE_BY_EMAIL: ChannelDefaults = {
    'org-owner': 'email',
    'org-admin': 'email',
    'team-admin': 'email',
    member: 'email',
};

export const agentWaitingKind = attentionKind('agent-waiting', EVERYONE_BY_EMAIL, {
    label: () => m.notification_agent_waiting_label(),
    line: (item, place, { locale }) =>
        m.notification_agent_waiting_line({ count: item.count, project: place.project?.label ?? '' }, { locale }),
    subject: (item, place, { locale }) =>
        m.notification_agent_waiting_line({ count: item.count, project: place.project?.label ?? '' }, { locale }),
});

export const taskFailedKind = attentionKind('task-failed', EVERYONE_BY_EMAIL, {
    label: () => m.notification_task_failed_label(),
    line: (item, place, { locale }) =>
        m.notification_task_failed_line({ count: item.count, project: place.project?.label ?? '' }, { locale }),
    subject: (item, place, { locale }) =>
        m.notification_task_failed_line({ count: item.count, project: place.project?.label ?? '' }, { locale }),
});

// Project-wide: the engine sends it without `to`, so it reaches the managers the dashboard knows, never members.
export const toolSignInKind = attentionKind(
    'tool-sign-in',
    { 'org-owner': 'email', 'org-admin': 'email', 'team-admin': 'email', member: 'off' },
    {
        label: () => m.notification_tool_sign_in_label(),
        line: (item, place, { locale }) =>
            m.notification_tool_sign_in_line({ count: item.count, project: place.project?.label ?? '' }, { locale }),
        subject: (item, place, { locale }) =>
            m.notification_tool_sign_in_line({ count: item.count, project: place.project?.label ?? '' }, { locale }),
    },
);
