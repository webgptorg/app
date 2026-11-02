import { Button, Card, EmptyState, ErrorState, Skeleton } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Plus, UsersRound } from 'lucide-react';
import { useState } from 'react';

import { m } from '../../../paraglide/messages';
import { apiRoutes, type EngineView, type TeamView } from '../../../shared/api/routes';
import type { TeamName } from '../../../shared/team-name';
import { useApiClient } from '../../api/api-client-context';
import { dataOrThrow, enginesQuery } from '../../api/queries';
import { Link } from '../../core/link';
import { useAppMutation } from '../../core/mutations';
import { EngineStatusBadge } from '../engines/engine-status-badge';
import { useSession } from '../session/use-session';
import { OpenTeamButton } from './open-team-button';
import { TeamNameDialog } from './team-name-dialog';
import { teamKeys, teamsQuery } from './team-queries';

const MANAGE_PERMISSION = 'team.manage';

function TeamRow(props: { readonly team: TeamView; readonly engine: EngineView | undefined }) {
    const { team, engine } = props;
    return (
        <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Link to="/teams/$teamId" params={{ teamId: team.teamId }} className="truncate font-medium">
                    {team.name}
                </Link>
                <span className="text-sm text-text-muted">{m.team_people_count({ count: team.memberCount })}</span>
            </div>
            {engine === undefined ? (
                <span className="text-sm text-text-muted">{team.engineId === null ? m.team_no_engine() : null}</span>
            ) : (
                <EngineStatusBadge engine={engine} />
            )}
            <OpenTeamButton team={team} />
        </li>
    );
}

/** Creates a team, then goes straight to linking its engine (teams spec, "Dashboard UI"). */
function NewTeamButton(props: { readonly primary: boolean }) {
    const api = useApiClient();
    const navigate = useNavigate();
    const [open, setOpen] = useState(false);
    const create = useAppMutation({
        mutationFn: async (name: TeamName) =>
            dataOrThrow(await api.call(apiRoutes.createTeam, { body: { name } })).team,
        invalidates: [teamKeys.all],
        onSuccess: async (team) => {
            setOpen(false);
            await navigate({ to: '/engines/new', search: { team: team.teamId } });
        },
    });
    return (
        <>
            <Button
                variant={props.primary ? 'primary' : 'secondary'}
                onClick={() => {
                    setOpen(true);
                }}
            >
                <Plus aria-hidden className="size-4" />
                {m.teams_new()}
            </Button>
            <TeamNameDialog
                open={open}
                title={m.teams_new_title()}
                submitLabel={m.teams_new_submit()}
                pending={create.isPending}
                onSubmit={(name) => {
                    create.mutate(name);
                }}
                onClose={() => {
                    setOpen(false);
                }}
            />
        </>
    );
}

/** `/teams`, the signed-in landing page: every team for owners and admins, a member's own teams otherwise. */
export function TeamListPage() {
    const api = useApiClient();
    const session = useSession();
    const canManage = session.activeOrg.permissions.includes(MANAGE_PERMISSION);
    const teams = useQuery(teamsQuery(api));
    const engines = useQuery(enginesQuery(api));
    const engineOf = (team: TeamView) => engines.data?.find((engine) => engine.engineId === team.engineId);

    function content() {
        if (teams.isPending) {
            return (
                <div>
                    <span className="sr-only">{m.loading()}</span>
                    <Skeleton className="h-24 w-full" />
                </div>
            );
        }
        if (teams.isError) {
            return (
                <ErrorState
                    message={m.teams_error()}
                    onRetry={() => void teams.refetch()}
                    retrying={teams.isFetching}
                />
            );
        }
        if (teams.data.length === 0) {
            return (
                <Card>
                    <EmptyState
                        icon={<UsersRound aria-hidden className="size-6" />}
                        title={canManage ? m.teams_empty_title() : m.teams_empty_member_title()}
                        headingLevel={2}
                        description={canManage ? m.teams_empty_body() : m.teams_empty_member_body()}
                        {...(canManage ? { action: <NewTeamButton primary /> } : {})}
                    />
                </Card>
            );
        }
        return (
            <Card>
                <ul className="-m-5 divide-y divide-divider" aria-label={m.teams_title()}>
                    {teams.data.map((team) => (
                        <TeamRow key={team.teamId} team={team} engine={engineOf(team)} />
                    ))}
                </ul>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h1 className="font-display text-2xl font-semibold">{m.teams_title()}</h1>
                {canManage && (teams.data?.length ?? 0) > 0 ? <NewTeamButton primary={false} /> : null}
            </div>
            {content()}
        </div>
    );
}
