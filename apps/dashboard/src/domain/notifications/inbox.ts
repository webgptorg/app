import type { EngineId, Hostname } from '@ptbk/protocol';

import { projectName } from '../../shared/engine-label';
import type { NotificationChannel, RecipientRole } from '../../shared/notifications/notification-kind';
import { effectiveChannel, NOTIFICATION_KIND_IDS, type NotificationKind } from '../../shared/notifications/registry';
import type { NotificationId, OrgId } from '../ids';
import type { Clock } from '../ports/clock';
import type { EngineStore } from '../registration/engine-store';
import type { OrgRole } from '../roles';
import type { TeamStore } from '../teams/team-store';
import { visibleEngineIds, type TeamActor } from '../teams/teams';
import type { NotificationStore } from './notification-store';
import type { UnsubscribeClaims } from './unsubscribe-tokens';

export interface InboxDeps {
    readonly store: NotificationStore;
    readonly engines: Pick<EngineStore, 'listForOrg'>;
    readonly teams: TeamStore;
    readonly clock: Clock;
}

/** The bell holds at most this many; older rows stay open and come back as newer ones close. */
export const INBOX_LIMIT = 50;

export interface InboxItem {
    readonly id: NotificationId;
    readonly kind: NotificationKind;
    readonly variant: string | null;
    readonly count: number;
    readonly openedAt: number;
    readonly updatedAt: number;
    readonly seen: boolean;
    readonly project: {
        readonly engineId: EngineId;
        readonly label: string;
        readonly hostname: Hostname;
    } | null;
}

export interface Inbox {
    readonly items: readonly InboxItem[];
    /** Other organizations of the person with something unseen, for the org switcher's dot. */
    readonly otherOrgsWithUnseen: readonly OrgId[];
}

/**
 * The actor's open notifications in their active organization, for projects they still see. A row about a project
 * they lost, or one revoked since, waits unseen for its close or the cleanup, rather than naming what they cannot open.
 */
export async function readInbox(deps: InboxDeps, actor: TeamActor): Promise<Inbox> {
    const [rows, unseen, engines, teams, visible] = await Promise.all([
        deps.store.listOpen(actor.orgId, actor.userId, INBOX_LIMIT),
        deps.store.orgsWithUnseen(actor.userId),
        deps.engines.listForOrg(actor.orgId),
        deps.teams.list(actor.orgId),
        visibleEngineIds(deps, actor),
    ]);
    const teamNames = new Map(teams.flatMap((team) => (team.engineId === null ? [] : [[team.engineId, team.name]])));
    const byId = new Map(
        engines.filter((engine) => engine.status === 'active').map((engine) => [engine.engineId, engine]),
    );
    const items = rows.flatMap((row): InboxItem[] => {
        if (row.engineId === null) {
            return [{ ...toItem(row), project: null }];
        }
        const engine = byId.get(row.engineId);
        if (engine === undefined || (visible !== null && !visible.has(row.engineId))) {
            return [];
        }
        return [
            {
                ...toItem(row),
                project: {
                    engineId: engine.engineId,
                    label: projectName({ ...engine, teamName: teamNames.get(engine.engineId) ?? null }),
                    hostname: engine.hostname,
                },
            },
        ];
    });
    return { items, otherOrgsWithUnseen: unseen.filter((orgId) => orgId !== actor.orgId) };
}

function toItem(row: {
    readonly id: NotificationId;
    readonly kind: NotificationKind;
    readonly variant: string | null;
    readonly count: number;
    readonly openedAt: number;
    readonly updatedAt: number;
    readonly seenAt: number | null;
}): Omit<InboxItem, 'project'> {
    return {
        id: row.id,
        kind: row.kind,
        variant: row.variant,
        count: row.count,
        openedAt: row.openedAt,
        updatedAt: row.updatedAt,
        seen: row.seenAt !== null,
    };
}

export function markInboxSeen(
    deps: Pick<InboxDeps, 'store' | 'clock'>,
    actor: TeamActor,
    ids: readonly NotificationId[],
): Promise<void> {
    return deps.store.markSeen(actor.orgId, actor.userId, ids, deps.clock.nowMs());
}

/** How a person's organization role reads for defaults; team admins are per project and come with ADR 0026. */
export function recipientRoleOf(role: OrgRole): RecipientRole {
    switch (role) {
        case 'owner':
            return 'org-owner';
        case 'admin':
            return 'org-admin';
        case 'member':
            return 'member';
    }
}

export interface PreferenceView {
    readonly kind: NotificationKind;
    readonly channel: NotificationChannel;
    readonly defaultChannel: NotificationChannel;
}

export async function readPreferences(
    deps: Pick<InboxDeps, 'store'>,
    actor: TeamActor,
): Promise<readonly PreferenceView[]> {
    const overrides = await deps.store.overrides(actor.orgId, actor.userId);
    const role = recipientRoleOf(actor.orgRole);
    return NOTIFICATION_KIND_IDS.map((kind) => ({
        kind,
        channel: effectiveChannel(kind, role, overrides.get(kind) ?? null),
        defaultChannel: effectiveChannel(kind, role, null),
    }));
}

/** Only overrides are stored: choosing the role's default removes one, so a later role change moves it along. */
export async function setPreference(
    deps: Pick<InboxDeps, 'store'>,
    actor: TeamActor,
    kind: NotificationKind,
    channel: NotificationChannel,
): Promise<readonly PreferenceView[]> {
    const isDefault = effectiveChannel(kind, recipientRoleOf(actor.orgRole), null) === channel;
    await deps.store.setOverride(actor.orgId, actor.userId, kind, isDefault ? null : channel);
    return readPreferences(deps, actor);
}

/**
 * A verified unsubscribe token's one effect: email off for its kinds, in-app kept. A kind already off stays off; the
 * person's role no longer matters, since this is their own choice now.
 */
export async function unsubscribe(deps: Pick<InboxDeps, 'store'>, claims: UnsubscribeClaims): Promise<void> {
    const overrides = await deps.store.overrides(claims.orgId, claims.userId);
    for (const kind of claims.kinds) {
        if (overrides.get(kind) !== 'off') {
            await deps.store.setOverride(claims.orgId, claims.userId, kind, 'in-app');
        }
    }
}
