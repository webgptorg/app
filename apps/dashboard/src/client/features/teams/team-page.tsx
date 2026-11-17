import {
    ActionMenu,
    Avatar,
    Banner,
    Button,
    ConfirmDialog,
    EmptyState,
    ErrorState,
    Section,
    Skeleton,
    StatusPill,
} from '@ptbk/ui';
import type { MenuEntry, StatusTone } from '@ptbk/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ChevronRight, SearchX, UserPlus } from 'lucide-react';
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
import { ButtonLink } from '../../core/link';
import { useAppMutation } from '../../core/mutations';
import { engineDisplayName, EngineMark } from '../engines/engine-identity';
import { EngineStatusPill } from '../engines/engine-status-pill';
import { ceremonyFailureMessage } from '../passkeys/ceremony-messages';
import { Crumb, Page } from '../shell/page';
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

const STATE_TONES: Readonly<Record<PersonState, StatusTone>> = {
    invited: 'neutral',
    'not-opened': 'neutral',
    waiting: 'waiting',
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
        <li className="flex items-center gap-3 py-2.5">
            <Avatar name={row.email} />
            <span className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="[overflow-wrap:anywhere]">{row.email}</span>
                    <span className="text-xs text-text-muted">{roleLabel(row.role)}</span>
                    {row.note === undefined ? null : <span className="text-xs">{row.note}</span>}
                </span>
                <StatusPill tone={STATE_TONES[row.state]} className="self-start sm:self-center">
                    {personStateLabel(row.state)}
                </StatusPill>
            </span>
            <span className="w-8 shrink-0">
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
        <EmptyState
            icon={<SearchX aria-hidden className="size-6" />}
            title={m.team_not_found_title()}
            headingLevel={1}
            description={m.team_not_found_body()}
            action={
                <ButtonLink to="/engines" variant="primary">
                    {m.engine_not_found_action()}
                </ButtonLink>
            }
        />
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
    const name = engineDisplayName(view, engine);
    const people = rows(team.data.members, team.data.removing, team.data.refused, team.data.invites);
    return (
        <Page
            title={name}
            leading={<EngineMark engineId={view.engineId} name={name} size="md" />}
            breadcrumbs={[
                <Crumb key="engines" to="/engines">
                    {m.nav_teams()}
                </Crumb>,
            ]}
            actions={
                <>
                    <OpenTeamButton team={view} variant="primary" size="md" />
                    <TeamMenu team={view} />
                </>
            }
            description={
                view.engineId === null ? undefined : (
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        {engine === undefined ? null : <EngineStatusPill engine={engine} />}
                        {engine === undefined || engine.hostname === name ? null : (
                            <span className="font-mono text-xs [overflow-wrap:anywhere]">{engine.hostname}</span>
                        )}
                        <ButtonLink
                            to="/engines/$engineId"
                            params={{ engineId: view.engineId }}
                            variant="ghost"
                            size="sm"
                            className="-ms-2"
                        >
                            {m.team_engine_details()}
                            <ChevronRight aria-hidden className="size-4" />
                        </ButtonLink>
                    </span>
                )
            }
        >
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
            ) : null}
            <Section
                title={m.team_people_title()}
                count={people.length}
                {...(view.engineId === null ? {} : { description: m.team_access_note() })}
                {...(permissions.includes(INVITE)
                    ? {
                          actions: (
                              <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                      setInviting(true);
                                  }}
                              >
                                  <UserPlus aria-hidden className="size-4" />
                                  {view.engineId === null ? m.invite_open() : m.invite_to_engine()}
                              </Button>
                          ),
                      }
                    : {})}
            >
                <ul className="divide-y divide-hairline">
                    {people.map((row) => (
                        <PersonRow
                            key={row.key}
                            row={row}
                            teamId={view.teamId}
                            self={row.userId === session.user.id}
                            canRemove={
                                permissions.includes(MEMBERS) &&
                                (row.role !== 'owner' || session.activeOrg.role === 'owner')
                            }
                        />
                    ))}
                </ul>
            </Section>
            <InviteDialog
                open={inviting}
                teamIds={[view.teamId]}
                {...(view.engineId === null ? {} : { engineName: name })}
                onClose={() => {
                    setInviting(false);
                }}
            />
        </Page>
    );
}
