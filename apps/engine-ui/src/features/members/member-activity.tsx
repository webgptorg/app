import type { Activity } from '@ptbk/engine-api';

import { Link } from '../../app/link';
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

/** The home feed's card body for a member event, linking to the member list. */
export function MemberActivityItem({ activity }: { readonly activity: Activity }) {
    return (
        <div className="flex flex-col gap-1 text-sm">
            <Link to="/members" variant="standalone" className="break-words">
                {memberActivitySummary(activity)}
            </Link>
        </div>
    );
}
