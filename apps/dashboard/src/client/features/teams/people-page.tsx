import {
    ActionMenu,
    Banner,
    Button,
    ConfirmDialog,
    ErrorState,
    Monogram,
    Section,
    Skeleton,
    StatusPill,
} from '@ptbk/ui';
import type { MenuEntry } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { useState } from 'react';

import { m } from '../../../paraglide/messages';
import { apiRoutes, type InviteView, type OrgMemberView, type TeamView } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { dataOrThrow, problemCode } from '../../api/queries';
import { useAppMutation } from '../../core/mutations';
import { useSession } from '../session/use-session';
import { Page } from '../shell/page';
import { InviteDialog } from './invite-dialog';
import { roleLabel, type OrgRole } from './team-labels';
import { peopleQuery, teamKeys, teamsQuery } from './team-queries';

const READ = 'org.members.read';
const MANAGE = 'org.members.manage';
const ROLES = 'org.roles.manage';
const ROLE_ORDER: readonly OrgRole[] = ['owner', 'admin', 'member'];
const ROW = 'flex items-center gap-3 py-2.5';
const LIST = 'divide-y divide-hairline';

function teamNames(teamIds: readonly string[], teams: readonly TeamView[] | undefined): string {
    const names = (teams ?? []).filter((team) => teamIds.includes(team.teamId)).map((team) => team.name);
    return names.length === 0 ? m.people_no_teams() : names.join(', ');
}

function lastOwnerMessage(error: unknown): string | undefined {
    return problemCode(error) === 'last-owner' ? m.people_last_owner() : undefined;
}

function MemberRow(props: { readonly member: OrgMemberView; readonly teams: readonly TeamView[] | undefined }) {
    const api = useApiClient();
    const session = useSession();
    const { member } = props;
    const [removing, setRemoving] = useState(false);
    const permissions = session.activeOrg.permissions;
    const changeRole = useAppMutation({
        mutationFn: async (role: OrgRole) => {
            dataOrThrow(await api.call(apiRoutes.changeOrgRole, { params: { userId: member.userId }, body: { role } }));
        },
        invalidates: [teamKeys.people],
        errorMessage: lastOwnerMessage,
        successMessage: (_, role) => m.people_role_changed({ email: member.email, role: roleLabel(role) }),
    });
    const remove = useAppMutation({
        mutationFn: async () => {
            dataOrThrow(await api.call(apiRoutes.removeOrgMember, { params: { userId: member.userId } }));
        },
        invalidates: [teamKeys.people, teamKeys.all],
        errorMessage: lastOwnerMessage,
        successMessage: () => m.people_removed({ email: member.email }),
        onSuccess: () => {
            setRemoving(false);
        },
    });
    const self = member.userId === session.user.id;
    const canRemove =
        !self && permissions.includes(MANAGE) && (member.role !== 'owner' || session.activeOrg.role === 'owner');
    const items: MenuEntry[] = [
        ...(permissions.includes(ROLES)
            ? [
                  { kind: 'heading' as const, id: 'role', label: m.people_role_heading() },
                  ...ROLE_ORDER.map((role) => ({
                      kind: 'item' as const,
                      id: `role-${role}`,
                      label: roleLabel(role),
                      checkable: 'radio' as const,
                      checked: member.role === role,
                      onSelect: () => {
                          if (role !== member.role) {
                              changeRole.mutate(role);
                          }
                      },
                  })),
              ]
            : []),
        ...(canRemove
            ? [
                  { kind: 'separator' as const, id: 'sep' },
                  {
                      kind: 'item' as const,
                      id: 'remove',
                      label: m.people_remove(),
                      tone: 'danger' as const,
                      onSelect: () => {
                          setRemoving(true);
                      },
                  },
              ]
            : []),
    ];
    return (
        <li className={ROW}>
            <Monogram name={member.email} />
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">
                    {member.email}
                    {self ? <span className="font-normal text-text-muted"> · {m.people_you()}</span> : null}
                </span>
                <span className="truncate text-xs text-text-muted">{teamNames(member.teamIds, props.teams)}</span>
            </span>
            <span className="shrink-0 text-sm text-text-muted">{roleLabel(member.role)}</span>
            <span className="flex w-8 shrink-0 justify-end">
                <ActionMenu
                    items={items}
                    variant="ghost"
                    size="sm"
                    label={m.team_person_actions({ email: member.email })}
                />
            </span>
            <ConfirmDialog
                open={removing}
                onClose={() => {
                    setRemoving(false);
                }}
                onConfirm={() => {
                    remove.mutate();
                }}
                title={m.people_remove_title({ email: member.email })}
                description={m.people_remove_body()}
                confirmLabel={m.people_remove()}
                tone="danger"
                loading={remove.isPending}
            />
        </li>
    );
}

function InviteRow(props: { readonly invite: InviteView }) {
    const api = useApiClient();
    const { invite } = props;
    const params = { inviteId: invite.inviteId };
    const resend = useAppMutation({
        mutationFn: async () => {
            dataOrThrow(await api.call(apiRoutes.resendInvite, { params }));
        },
        invalidates: [teamKeys.people],
        successMessage: () => m.people_invite_resent({ email: invite.email }),
    });
    const revoke = useAppMutation({
        mutationFn: async () => {
            dataOrThrow(await api.call(apiRoutes.revokeInvite, { params }));
        },
        invalidates: [teamKeys.people, teamKeys.all],
        successMessage: () => m.people_invite_revoked({ email: invite.email }),
    });
    const items: MenuEntry[] = [
        {
            kind: 'item',
            id: 'resend',
            label: m.people_invite_resend(),
            onSelect: () => {
                resend.mutate();
            },
        },
        { kind: 'separator', id: 'sep' },
        {
            kind: 'item',
            id: 'revoke',
            label: m.people_invite_revoke(),
            tone: 'danger',
            onSelect: () => {
                revoke.mutate();
            },
        },
    ];
    return (
        <li className={ROW}>
            <Monogram name={invite.email} />
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{invite.email}</span>
                <span className="truncate text-xs text-text-muted">{roleLabel(invite.role)}</span>
            </span>
            <StatusPill tone="waiting" className="shrink-0">
                {m.team_state_invited()}
            </StatusPill>
            <span className="flex w-8 shrink-0 justify-end">
                <ActionMenu
                    items={items}
                    variant="ghost"
                    size="sm"
                    label={m.team_person_actions({ email: invite.email })}
                />
            </span>
        </li>
    );
}

/** `/people`: the organization's people, their roles and teams, and pending invitations (owners and admins). */
export function PeoplePage() {
    const api = useApiClient();
    const session = useSession();
    const allowed = session.activeOrg.permissions.includes(READ);
    const people = useQuery({ ...peopleQuery(api), enabled: allowed });
    const teams = useQuery(teamsQuery(api));
    const [inviting, setInviting] = useState(false);

    function content() {
        if (!allowed) {
            return <Banner tone="info">{m.people_not_allowed()}</Banner>;
        }
        if (people.isPending) {
            return (
                <div>
                    <span className="sr-only">{m.loading()}</span>
                    <Skeleton className="h-40 w-full" />
                </div>
            );
        }
        if (people.isError) {
            return (
                <ErrorState
                    message={m.people_error()}
                    onRetry={() => void people.refetch()}
                    retrying={people.isFetching}
                />
            );
        }
        return (
            <>
                <Section title={m.people_members_title()} count={people.data.members.length} divided={false}>
                    <ul className={LIST}>
                        {people.data.members.map((member) => (
                            <MemberRow key={member.userId} member={member} teams={teams.data} />
                        ))}
                    </ul>
                </Section>
                {people.data.invites.length === 0 ? null : (
                    <Section title={m.people_invites_title()} count={people.data.invites.length}>
                        <ul className={LIST}>
                            {people.data.invites.map((invite) => (
                                <InviteRow key={invite.inviteId} invite={invite} />
                            ))}
                        </ul>
                    </Section>
                )}
            </>
        );
    }

    return (
        <Page
            title={m.people_title()}
            actions={
                session.activeOrg.permissions.includes(MANAGE) ? (
                    <Button
                        variant="primary"
                        onClick={() => {
                            setInviting(true);
                        }}
                    >
                        <UserPlus aria-hidden className="size-4" />
                        {m.invite_open()}
                    </Button>
                ) : undefined
            }
        >
            {content()}
            <InviteDialog
                open={inviting}
                onClose={() => {
                    setInviting(false);
                }}
            />
        </Page>
    );
}
