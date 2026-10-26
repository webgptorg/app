import type { Member, Passkey } from '@ptbk/engine-api';

interface MembersAndPasskeys {
    readonly members: readonly Member[];
    readonly passkeys: readonly Passkey[];
}

function canSignIn(snapshot: MembersAndPasskeys): readonly Member[] {
    const withPasskey = new Set(snapshot.passkeys.map(({ memberId }) => memberId));
    return snapshot.members.filter((member) => member.status === 'active' && withPasskey.has(member.id));
}

/**
 * The heartbeat's `members`: active members with at least one passkey, so it is 0 until the owner's first passkey
 * and 0 again after `owner --reset` (installation.md, "What the dashboard reads").
 */
export function membersWhoCanSignIn(snapshot: MembersAndPasskeys): number {
    return canSignIn(snapshot).length;
}

/** Whether setup is done: an active owner holds a passkey. Until then the setup link is the only way in. */
export function hasOwner(snapshot: MembersAndPasskeys): boolean {
    return canSignIn(snapshot).some((member) => member.role === 'owner');
}
