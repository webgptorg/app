import { ActionMenu, Badge, Banner, Button, Card, ConfirmDialog, EmptyState, ErrorState, Skeleton } from '@ptbk/ui';
import type { MenuEntry } from '@ptbk/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowLeft, SearchX, UserPlus } from 'lucide-react';
import { useState } from 'react';

import { m } from '../../../paraglide/messages';
import {
    apiRoutes,
    type InviteView,
    type PersonView,
    type RefusedView,
    type TeamMemberView,
    type TeamView,
} from '../../../shared/api/routes';
import type { TeamName } from '../../../shared/team-name';
import { useApiClient } from '../../api/api-client-context';
import { dataOrThrow, enginesQuery, problemCode, queryKeys } from '../../api/queries';
import { ButtonLink, Link } from '../../core/link';
import { useAppMutation } from '../../core/mutations';
import { EngineStatusBadge } from '../engines/engine-status-badge';
import { ceremonyFailureMessage } from '../passkeys/ceremony-messages';
import { useSession } from '../session/use-session';
import { StepUpFailedError, useStepUp } from '../step-up/step-up';
import { InviteDialog } from './invite-dialog';
import { accessState, personStateLabel, roleLabel, type PersonState } from './team-labels';
import { OpenTeamButton } from './open-team-button';
import { TeamNameDialog } from './team-name-dialog';
import { teamKeys, teamQuery } from './team-queries';

const MANAGE = 'team.manage';
const DELETE = 'team.delete';
const MEMBERS = 'team.members.manage';
const INVITE = 'org.members.manage';
const LINK = 'engine.link';

interface Row {
    readonly key: string;
    readonly email: string;
    readonly role: PersonView['role'];
    readonly state: PersonState;
    readonly userId: string | null;
    /** Why they are still on the engine, when it refused the removal. */
    readonly note?: string;
}

/** Everyone the team page lists, in one order: people in the team, then those on their way in or out. */
function rows(
    members: readonly TeamMemberView[],
    removing: readonly PersonView[],
    refused: readonly RefusedView[],
    invites: readonly InviteView[],
): Row[] {
    return [
        ...members.map((person) => ({
            key: person.userId,
            email: person.email,
            role: person.role,
            state: accessState(person.access),
            userId: person.userId,
        })),
        ...invites.map((invite) => ({
            key: invite.inviteId,
            email: invite.email,
            role: invite.role,
            state: 'invited' as const,
            userId: null,
        })),
        ...removing.map((person) => ({
            key: `removing-${person.userId}`,
            email: person.email,
            role: person.role,
            state: 'removing' as const,
            userId: null,
        })),
        ...refused.map((person) => ({
            key: `refused-${person.userId}`,
            email: person.email,
            role: person.role,
            state: 'refused' as const,
            userId: null,
            note: person.outcome === 'refused-owner' ? m.team_refused_owner() : m.team_refused_disabled(),
        })),
    ];
}

const STATE_TONES: Readonly<Record<PersonState, 'neutral' | 'info' | 'success' | 'warning'>> = {
    invited: 'neutral',
    'not-opened': 'neutral',
    waiting: 'info',
    'has-access': 'success',
    removing: 'warning',
    refused: 'warning',
};

function PersonRow(props: {
    readonly row: Row;
    readonly teamId: string;
    readonly self: boolean;
    readonly canRemove: boolean;
}) {
    const api = useApiClient();
    const { row } = props;
    const [confirming, setConfirming] = useState(false);
    const remove = useAppMutation({
        mutationFn: async () => {
            const { teamId } = props;
            dataOrThrow(
                props.self
                    ? await api.call(apiRoutes.leaveTeam, { params: { teamId } })
                    : await api.call(apiRoutes.removeTeamMember, { params: { teamId, userId: row.userId ?? '' } }),
            );
        },
        invalidates: [teamKeys.team(props.teamId), teamKeys.all, teamKeys.people],
        successMessage: () => (props.self ? m.team_left() : m.team_member_removed({ email: row.email })),
        onSuccess: () => {
            setConfirming(false);
        },
    });
    const items: MenuEntry[] =
        row.userId === null || !(props.canRemove || props.self)
            ? []
            : [
                  {
                      kind: 'item',
                      id: 'remove',
                      label: props.self ? m.team_leave() : m.team_member_remove(),
                      tone: 'danger',
                      onSelect: () => {
                          setConfirming(true);
                      },
                  },
              ];
    return (
        <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{row.email}</span>
                <span className="text-sm text-text-muted">{roleLabel(row.role)}</span>
                {row.note === undefined ? null : <span className="text-sm">{row.note}</span>}
            </span>
            <Badge tone={STATE_TONES[row.state]}>{personStateLabel(row.state)}</Badge>
            <span className="w-9">
                <ActionMenu
                    items={items}
                    variant="ghost"
                    size="sm"
                    label={m.team_person_actions({ email: row.email })}
                />
            </span>
            <ConfirmDialog
                open={confirming}
                onClose={() => {
                    setConfirming(false);
                }}
                onConfirm={() => {
                    remove.mutate();
                }}
                title={props.self ? m.team_leave_title() : m.team_member_remove_title({ email: row.email })}
                description={m.team_member_remove_body()}
                confirmLabel={props.self ? m.team_leave() : m.team_member_remove()}
                tone="danger"
                loading={remove.isPending}
            />
        </li>
    );
}

function TeamMenu(props: { readonly team: TeamView }) {
    const api = useApiClient();
    const session = useSession();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [renaming, setRenaming] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const { teamId } = props.team;
    const rename = useAppMutation({
        mutationFn: async (name: TeamName) =>
            dataOrThrow(await api.call(apiRoutes.renameTeam, { params: { teamId }, body: { name } })).team,
        invalidates: [teamKeys.all],
        onSuccess: async () => {
            setRenaming(false);
            await queryClient.invalidateQueries({ queryKey: teamKeys.team(teamId) });
        },
    });
    const { needsStepUp, stepUpInPlace } = useStepUp();
    const remove = useAppMutation({
        stepUp: 'in-place',
        mutationFn: async () => {
            if (needsStepUp()) {
                await stepUpInPlace();
            }
            dataOrThrow(await api.call(apiRoutes.deleteTeam, { params: { teamId } }));
        },
        invalidates: [teamKeys.all, queryKeys.engines],
        successMessage: () => m.team_deleted({ name: props.team.name }),
        onSuccess: async () => {
            setDeleting(false);
            await navigate({ to: '/engines' });
        },
    });
    const permissions = session.activeOrg.permissions;
    const items: MenuEntry[] = [
        ...(permissions.includes(MANAGE)
            ? [
                  {
                      kind: 'item' as const,
                      id: 'rename',
                      label: m.team_rename(),
                      onSelect: () => {
                          setRenaming(true);
                      },
                  },
              ]
            : []),
        ...(permissions.includes(DELETE)
            ? [
                  { kind: 'separator' as const, id: 'sep' },
                  {
                      kind: 'item' as const,
                      id: 'delete',
                      label: m.team_delete(),
                      tone: 'danger' as const,
                      onSelect: () => {
                          setDeleting(true);
                      },
                  },
              ]
            : []),
    ];
    return (
        <>
            <ActionMenu items={items} label={m.team_actions({ name: props.team.name })} />
            <TeamNameDialog
                open={renaming}
                title={m.team_rename_title()}
                submitLabel={m.team_rename_submit()}
                initial={props.team.name}
                pending={rename.isPending}
                onSubmit={(name) => {
                    rename.mutate(name);
                }}
                onClose={() => {
                    setRenaming(false);
                }}
            />
            <ConfirmDialog
                open={deleting}
                onClose={() => {
                    setDeleting(false);
                    remove.reset();
                }}
                onConfirm={() => {
                    remove.mutate();
                }}
                {...(remove.error instanceof StepUpFailedError
                    ? { error: ceremonyFailureMessage(remove.error.failure, 'authenticate') }
                    : {})}
                title={m.team_delete_title({ name: props.team.name })}
                description={props.team.engineId === null ? m.team_delete_body_no_engine() : m.team_delete_body()}
                confirmLabel={m.team_delete()}
                tone="danger"
                confirmPhrase={props.team.name}
                loading={remove.isPending}
            />
        </>
    );
}

function NotFound() {
    return (
        <Card>
            <EmptyState
                icon={<SearchX aria-hidden className="size-6" />}
                title={m.team_not_found_title()}
                headingLevel={2}
                description={m.team_not_found_body()}
                action={<ButtonLink to="/engines">{m.team_back()}</ButtonLink>}
            />
        </Card>
    );
}

/** `/teams/:teamId`: the team's engine, its people with where each stands, and the ways in and out. */
export function TeamPage(props: { readonly teamId: string }) {
    const api = useApiClient();
    const session = useSession();
    const team = useQuery(teamQuery(api, props.teamId));
    const engines = useQuery(enginesQuery(api));
    const [inviting, setInviting] = useState(false);
    const permissions = session.activeOrg.permissions;

    if (team.isPending) {
        return (
            <div>
                <span className="sr-only">{m.loading()}</span>
                <Skeleton className="h-40 w-full" />
            </div>
        );
    }
    if (team.isError) {
        return problemCode(team.error) === 'not-found' ? (
            <NotFound />
        ) : (
            <ErrorState message={m.team_error()} onRetry={() => void team.refetch()} retrying={team.isFetching} />
        );
    }
    const view = team.data.team;
    const engine = engines.data?.find((candidate) => candidate.engineId === view.engineId);
    const people = rows(team.data.members, team.data.removing, team.data.refused, team.data.invites);
    return (
        <div className="flex flex-col gap-6">
            <Link to="/engines" variant="standalone" className="inline-flex items-center gap-1 self-start text-sm">
                <ArrowLeft aria-hidden className="size-4" />
                {m.team_back()}
            </Link>
            <div className="flex flex-wrap items-center gap-3">
                <h1 className="min-w-0 flex-1 font-display text-2xl font-semibold break-words">{view.name}</h1>
                <OpenTeamButton team={view} variant="primary" />
                <TeamMenu team={view} />
            </div>
            {view.engineId === null ? (
                <Banner tone="info">
                    <span className="flex flex-wrap items-center gap-3">
                        {m.team_no_engine_body()}
                        {permissions.includes(LINK) ? (
                            <ButtonLink to="/engines/new" search={{ team: view.teamId }} variant="primary" size="sm">
                                {m.team_link_engine()}
                            </ButtonLink>
                        ) : null}
                    </span>
                </Banner>
            ) : (
                <p className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
                    {m.team_engine()}
                    {engine === undefined ? null : <EngineStatusBadge engine={engine} />}
                    <Link to="/engines/$engineId" params={{ engineId: view.engineId }}>
                        {m.team_engine_details()}
                    </Link>
                </p>
            )}
            <Card
                title={m.team_people_title()}
                {...(permissions.includes(INVITE)
                    ? {
                          actions: (
                              <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => {
                                      setInviting(true);
                                  }}
                              >
                                  <UserPlus aria-hidden className="size-4" />
                                  {m.invite_open()}
                              </Button>
                          ),
                      }
                    : {})}
            >
                <ul className="-mx-5 -mb-5 divide-y divide-divider border-t border-divider">
                    {people.map((row) => (
                        <PersonRow
                            key={row.key}
                            row={row}
                            teamId={view.teamId}
                            self={row.userId === session.user.id}
                            canRemove={permissions.includes(MEMBERS)}
                        />
                    ))}
                </ul>
            </Card>
            {view.engineId === null ? null : <p className="text-sm text-text-muted">{m.team_access_note()}</p>}
            <InviteDialog
                open={inviting}
                teamIds={[view.teamId]}
                onClose={() => {
                    setInviting(false);
                }}
            />
        </div>
    );
}
