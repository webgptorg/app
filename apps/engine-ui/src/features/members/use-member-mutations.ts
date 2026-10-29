import { Timestamp } from '@ptbk/engine-api';
import type { Invite, MemberId, Role } from '@ptbk/engine-api';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { roleLabel } from '../shell/role-label';
import { memberKeys } from './members-keys';

const MUTATION_TIMEOUT_MS = 30_000;
const DAY_MS = 24 * 60 * 60_000;

export interface MemberTarget {
    readonly id: MemberId;
    readonly displayName: string;
}

export interface InviteRequest {
    readonly role: Role;
    readonly days: number;
    /**
     * Receives the invite URL. It carries the invite secret, so it goes straight to the dialog that shows it once and
     * never into the mutation's result, which TanStack Query keeps in its cache.
     */
    readonly reveal: (inviteUrl: string) => void;
}

/** Role changes, removals and invites: none optimistic, each waits for the engine and may need step-up. */
export function useMemberMutations() {
    const engineApi = useEngineApi();
    const signal = () => AbortSignal.timeout(MUTATION_TIMEOUT_MS);

    const changeRole = useStepUpAwareMutation({
        mutationFn: async ({ member, role }: { readonly member: MemberTarget; readonly role: Role }) =>
            unwrap(await engineApi.members.update(member.id, { role }, signal())),
        invalidates: [memberKeys.all],
        successMessage: (_, { member, role }) =>
            m.members_role_changed({ name: member.displayName, role: roleLabel(role) }),
        errorMessage: (_, { member }) => m.members_role_change_failed({ name: member.displayName }),
    });

    const remove = useStepUpAwareMutation({
        mutationFn: async (member: MemberTarget) => unwrap(await engineApi.members.remove(member.id, signal())),
        invalidates: [memberKeys.all],
        successMessage: (_, member) => m.members_removed({ name: member.displayName }),
        errorMessage: (_, member) => m.members_remove_failed({ name: member.displayName }),
    });

    const invite = useStepUpAwareMutation({
        mutationFn: async ({ role, days, reveal }: InviteRequest): Promise<Invite> => {
            const expiresAt = Timestamp.parse(new Date(Date.now() + days * DAY_MS).toISOString());
            const created = unwrap(await engineApi.members.createInvite({ role, expiresAt }, signal()));
            reveal(created.inviteUrl);
            return created.invite;
        },
        invalidates: [memberKeys.invites()],
        errorMessage: () => m.invites_create_failed(),
    });

    const revokeInvite = useStepUpAwareMutation({
        mutationFn: async (invite: Invite) => unwrap(await engineApi.members.revokeInvite(invite.id, signal())),
        invalidates: [memberKeys.invites()],
        successMessage: (_, invite) => m.invites_revoked({ role: roleLabel(invite.role) }),
        errorMessage: () => m.invites_revoke_failed(),
    });

    return { changeRole, remove, invite, revokeInvite };
}

export type MemberMutations = ReturnType<typeof useMemberMutations>;
