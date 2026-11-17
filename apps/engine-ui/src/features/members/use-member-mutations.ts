import type { AccessRequest, Invite, MemberId, Role } from '@ptbk/engine-api';

import { classifyApiError, unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { roleLabel } from '../shell/role-label';
import { memberKeys } from './members-keys';

const MUTATION_TIMEOUT_MS = 30_000;

export interface MemberTarget {
    readonly id: MemberId;
    readonly displayName: string;
}

export const APPROVE_ACCESS_ACTION = 'members.approve-access';

export interface AccessApproval {
    readonly request: AccessRequest;
    readonly code: string;
    readonly role: Role;
}

/** `attemptsRemaining` comes from the engine; engines built before it was added leave it out. */
export type ApprovalOutcome =
    { readonly kind: 'approved' } | { readonly kind: 'code-mismatch'; readonly attemptsRemaining: number | undefined };

/**
 * Role changes, removals, revoking the engine's own invites and access requests: none optimistic, each waits for the
 * engine and may need step-up. New people are invited from the dashboard, so the UI no longer creates engine invites.
 */
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
                return { kind: 'approved' };
            } catch (error) {
                // A wrong code is the member's typo, answered in the dialog, not a failure toast.
                const failure = classifyApiError(error);
                if (failure.kind === 'problem' && failure.problem.code === 'access-code-mismatch')
                    return { kind: 'code-mismatch', attemptsRemaining: failure.problem.attemptsRemaining };
                throw error;
            }
        },
        invalidates: [memberKeys.all],
        successMessage: (outcome, { request }) =>
            outcome.kind === 'approved' ? m.access_approved({ name: request.displayName }) : undefined,
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

    return { changeRole, remove, revokeInvite, approveAccess, declineAccess };
}

export type MemberMutations = ReturnType<typeof useMemberMutations>;
