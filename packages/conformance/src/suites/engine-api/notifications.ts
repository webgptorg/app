import { ENGINE_API_ROUTES, KNOWN_CAPABILITIES, MAX_NOTIFICATIONS_PER_SEEN, OWNER_PERMISSIONS } from '@ptbk/engine-api';
import type { Notification, NotificationCounts, NotificationKind } from '@ptbk/engine-api';

import type { CheckContext, ConformanceCheck } from '../../check';
import { Findings, skip } from '../../check';
import { randomToken } from '../../random';
import type { NotificationsTarget } from '../../target';
import { EngineApi, describe } from './api';
import { requireCapability } from './capability-support';
import { SUITE, attempt } from './support';
import type { World } from './world';
import { allPermissionsExcept, createWorld, sessionFor } from './world';

const R = ENGINE_API_ROUTES;
const NOTIFICATIONS = KNOWN_CAPABILITIES.notifications;
/** A member who manages nothing, so project-wide items are not theirs to see. */
const NON_MANAGER = allPermissionsExcept('settings.manage', OWNER_PERMISSIONS);

interface Inbox {
    readonly world: World;
    readonly lever: NotificationsTarget;
    /** Raises an item for `api`'s member, or a project-wide one with `null`, titled with a fresh token. */
    raise(api: EngineApi | null, kind?: NotificationKind): Promise<{ readonly id: string; readonly title: string }>;
}

async function openInbox(ctx: CheckContext): Promise<Inbox> {
    const world = await createWorld(ctx);
    await requireCapability(world, NOTIFICATIONS);
    const lever = ctx.target.notifications;
    if (lever === undefined) skip('the target cannot raise notifications (no test-mode lever)');
    return {
        world,
        lever,
        async raise(api, kind = 'agent-waiting') {
            const memberId = api === null ? null : (await api.ok(R.getMe)).memberId;
            const title = `conformance-${ctx.runId}-${randomToken(ctx.random, 16)}`;
            return { id: await lever.raise({ memberId, kind, title }), title };
        },
    };
}

async function listed(api: EngineApi): Promise<readonly Notification[]> {
    return (await api.ok(R.listMyNotifications, { query: { limit: 100 } })).items;
}

function countsDiffer(before: NotificationCounts, after: NotificationCounts, kind: NotificationKind, by: number) {
    return after.byKind[kind] !== before.byKind[kind] - by || after.total !== before.total - by;
}

export const NOTIFICATION_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.notifications.own-items',
        suite: SUITE,
        title: 'Each member lists only their own notifications; marking another person’s seen is 404 and changes nothing',
        async run(ctx) {
            const inbox = await openInbox(ctx);
            const { owner } = inbox.world;
            const member = await sessionFor(ctx, { kind: 'member', permissions: NON_MANAGER }, 'a second member');
            const mine = await inbox.raise(owner);
            const theirs = await inbox.raise(member);
            const findings = new Findings();
            const ownerTitles = (await listed(owner)).map(({ title }) => title);
            const memberTitles = (await listed(member)).map(({ title }) => title);
            if (!ownerTitles.includes(mine.title)) findings.add('the owner does not see their own notification');
            if (ownerTitles.includes(theirs.title)) findings.add('the owner sees a notification for another member');
            if (!memberTitles.includes(theirs.title)) findings.add('the member does not see their own notification');
            if (memberTitles.includes(mine.title)) findings.add('the member sees the owner’s notification');
            const before = await owner.ok(R.getMyNotificationCounts);
            await attempt(findings, async () => {
                await member.problem(R.markMyNotificationsSeen, { body: { ids: [mine.id] } }, 'not-found');
            });
            await attempt(findings, async () => {
                await member.problem(R.markMyNotificationsSeen, { body: { ids: [theirs.id, mine.id] } }, 'not-found');
            });
            const after = await owner.ok(R.getMyNotificationCounts);
            if (countsDiffer(before, after, 'agent-waiting', 0)) {
                findings.add(`${describe(R.markMyNotificationsSeen)}: another member’s refused request changed counts`);
            }
            const stillUnseen = (await listed(member)).find(({ id }) => id === theirs.id)?.seenAt === null;
            if (!stillUnseen) findings.add('a refused batch marked the member’s own item seen anyway');
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.notifications.seen-lowers-count',
        suite: SUITE,
        title: 'Marking a notification seen lowers its kind’s unseen count by one, sets seenAt and keeps it listed',
        async run(ctx) {
            const inbox = await openInbox(ctx);
            const member = await sessionFor(ctx, { kind: 'member', permissions: NON_MANAGER }, 'a member’s inbox');
            const first = await inbox.raise(member, 'task-failed');
            await inbox.raise(member, 'task-failed');
            const findings = new Findings();
            const before = await member.ok(R.getMyNotificationCounts);
            if (before.byKind['task-failed'] < 2) findings.add('two raised task-failed items do not count as unseen');
            const answered = await member.ok(R.markMyNotificationsSeen, { body: { ids: [first.id] } });
            const after = await member.ok(R.getMyNotificationCounts);
            if (countsDiffer(before, after, 'task-failed', 1)) {
                findings.add(
                    `unseen task-failed went ${String(before.byKind['task-failed'])} → ${String(after.byKind['task-failed'])}, total ${String(before.total)} → ${String(after.total)}`,
                );
            }
            if (JSON.stringify(answered) !== JSON.stringify(after)) {
                findings.add(
                    `${describe(R.markMyNotificationsSeen)} answers other counts than GET /me/notifications/unseen`,
                );
            }
            const item = (await listed(member)).find(({ id }) => id === first.id);
            if (item === undefined) findings.add('a seen item left the inbox; only handling it closes it');
            else if (item.seenAt === null) findings.add('a seen item still has seenAt null');
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.notifications.project-wide',
        suite: SUITE,
        title: 'Project-wide notifications reach members holding settings.manage, never other members',
        async run(ctx) {
            const inbox = await openInbox(ctx);
            const { owner } = inbox.world;
            const member = await sessionFor(ctx, { kind: 'member', permissions: NON_MANAGER }, 'a non-manager');
            const project = await inbox.raise(null, 'tool-sign-in');
            const findings = new Findings();
            const ownerItem = (await listed(owner)).find(({ id }) => id === project.id);
            if (ownerItem?.audience !== 'project')
                findings.add('the owner does not see the project-wide item as project');
            if ((await listed(member)).some(({ audience }) => audience === 'project')) {
                findings.add('a member without settings.manage sees project-wide items');
            }
            await attempt(findings, async () => {
                await member.problem(R.markMyNotificationsSeen, { body: { ids: [project.id] } }, 'not-found');
            });
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.notifications.strict-input',
        suite: SUITE,
        title: 'The inbox refuses anonymous callers with 401, and mark-seen bodies with unknown fields, no IDs or too many',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, NOTIFICATIONS);
            const findings = new Findings();
            const anonymous = new EngineApi(ctx, null);
            await attempt(findings, async () => {
                await anonymous.problem(R.listMyNotifications, {}, 'unauthenticated');
            });
            await attempt(findings, async () => {
                await anonymous.problem(R.getMyNotificationCounts, {}, 'unauthenticated');
            });
            await attempt(findings, async () => {
                await anonymous.problem(R.markMyNotificationsSeen, { body: { ids: ['n1'] } }, 'unauthenticated');
            });
            const tooMany = Array.from({ length: MAX_NOTIFICATIONS_PER_SEEN + 1 }, (_, index) => `n${String(index)}`);
            for (const body of [{ ids: ['n1'], all: true }, { ids: [] }, { ids: tooMany }, {}]) {
                await attempt(findings, async () => {
                    await world.owner.problem(R.markMyNotificationsSeen, { body }, 'validation-failed');
                });
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.notifications.switch',
        suite: SUITE,
        title: 'GET /settings reports dashboardAttention; only settings.manage changes it, and the change sticks',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, NOTIFICATIONS);
            const findings = new Findings();
            const initial = (await world.owner.ok(R.getSettings)).dashboardAttention;
            if (typeof initial !== 'boolean') {
                findings.add('GET /settings: dashboardAttention is null on an engine with notifications@1');
                return findings.outcome();
            }
            const member = await sessionFor(
                ctx,
                { kind: 'member', permissions: allPermissionsExcept('settings.manage', OWNER_PERMISSIONS) },
                'a member without settings.manage',
            );
            await attempt(findings, async () => {
                await member.problem(R.setDashboardAttention, { body: { enabled: !initial } }, 'forbidden');
            });
            if ((await world.owner.ok(R.getSettings)).dashboardAttention !== initial) {
                findings.add(`${describe(R.setDashboardAttention)}: a refused request changed the switch`);
            }
            const flipped = await world.owner.call(R.setDashboardAttention, { body: { enabled: !initial } });
            if (flipped.kind === 'problem' && flipped.problem.code === 'step-up-required') {
                skip('the engine wants a fresh passkey for the switch, which the suite cannot give');
            }
            ctx.resources.defer((signal) =>
                world.owner.withSignal(signal).send(R.setDashboardAttention, { body: { enabled: initial } }),
            );
            if (flipped.kind === 'problem') {
                findings.add(`${describe(R.setDashboardAttention)}: the owner got ${flipped.problem.code}`);
            } else if ((await world.owner.ok(R.getSettings)).dashboardAttention !== !initial) {
                findings.add('GET /settings does not report the switch the owner just set');
            }
            return findings.outcome();
        },
    },
];
