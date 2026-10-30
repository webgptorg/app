import { Timestamp } from '@ptbk/engine-api';
import type { AccessRequest, Invite, MemberId, Role } from '@ptbk/engine-api';

import { classifyApiError, unwrap } from '../../app/api-errors';
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

export const APPROVE_ACCESS_ACTION = 'members.approve-access';

export interface AccessApproval {
    readonly request: AccessRequest;
    readonly code: string;
    readonly role: Role;
}

export type ApprovalOutcome = 'approved' | 'code-mismatch';

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

    const approveAccess = useStepUpAwareMutation({
        mutationFn: async ({ request, code, role }: AccessApproval): Promise<ApprovalOutcome> => {
            try {
                unwrap(await engineApi.members.approveAccessRequest(request.id, { code, role }, signal()));
                return 'approved';
            } catch (error) {
                // A wrong code is the member's typo, answered in the dialog, not a failure toast.
                const failure = classifyApiError(error);
                if (failure.kind === 'problem' && failure.problem.code === 'access-code-mismatch')
                    return 'code-mismatch';
                throw error;
            }
        },
        invalidates: [memberKeys.all],
        successMessage: (outcome, { request }) =>
            outcome === 'approved' ? m.access_approved({ name: request.displayName }) : undefined,
        errorMessage: (_, { request }) => m.access_approve_failed({ name: request.displayName }),
        // The code is not kept: the member asks for it again after confirming it was them.
        resumeAs: {
            action: APPROVE_ACCESS_ACTION,
            data: ({ request, role }) => ({ accessRequestId: request.id, role }),
        },
    });

    const declineAccess = useStepUpAwareMutation({
        mutationFn: async (request: AccessRequest) =>
            unwrap(await engineApi.members.declineAccessRequest(request.id, signal())),
        invalidates: [memberKeys.accessRequests()],
        successMessage: (_, request) => m.access_declined({ name: request.displayName }),
        errorMessage: () => m.access_decline_failed(),
    });

    return { changeRole, remove, invite, revokeInvite, approveAccess, declineAccess };
}

export type MemberMutations = ReturnType<typeof useMemberMutations>;
