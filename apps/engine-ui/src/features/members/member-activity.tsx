import type { Activity } from '@ptbk/engine-api';

import { ActivityLine } from '../entities/activity-line';
import type { ActivityOutcome } from '../entities/activity-line';
import { EntityChip } from '../entities/entity-chip';
import { m } from '../../paraglide/messages';
import { roleLabel } from '../shell/role-label';

type MemberActivity = Extract<Activity, { readonly kind: `member.${string}` }>;

function isMemberActivity(activity: Activity): activity is MemberActivity {
    return activity.kind.startsWith('member.');
}

/** One line per `member.*` kind (v1); the display name is member-typed text and stays text. */
export function memberActivitySummary(activity: Activity): string {
    if (!isMemberActivity(activity)) return activity.kind;
    const name = activity.displayName;
    switch (activity.kind) {
        case 'member.joined':
            return m.member_activity_joined({ name });
        case 'member.role-changed':
            return m.member_activity_role_changed({
                name,
                from: roleLabel(activity.previousRole),
                to: roleLabel(activity.role),
            });
        case 'member.removed':
            return m.member_activity_removed({ name });
    }
}

function memberOutcome(activity: MemberActivity): ActivityOutcome {
    switch (activity.kind) {
        case 'member.joined':
            return { tone: 'success', label: m.activity_outcome_joined() };
        case 'member.role-changed':
            return { tone: 'info', label: m.activity_outcome_role_changed() };
        case 'member.removed':
            return { tone: 'neutral', label: m.activity_outcome_removed() };
    }
}

/** A member event as an activity line: the member as a chip (a removed one has nowhere to go), a new role as a fact. */
export function MemberActivityItem({ activity }: { readonly activity: Activity }) {
    if (!isMemberActivity(activity)) return null;
    return (
        <ActivityLine
            activity={activity}
            description={
                <EntityChip
                    kind="member"
                    id={activity.kind === 'member.removed' ? null : activity.memberId}
                    name={activity.displayName}
                />
            }
            outcome={memberOutcome(activity)}
            facts={
                activity.kind === 'member.role-changed'
                    ? m.activity_role_change({ from: roleLabel(activity.previousRole), to: roleLabel(activity.role) })
                    : null
            }
        />
    );
}
