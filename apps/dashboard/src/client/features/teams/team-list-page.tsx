import { Button, EmptyState, ErrorState, Skeleton } from '@ptbk/ui';
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
import { engineDisplayName, EngineIdentity } from '../engines/engine-identity';
import { EngineStatusPill } from '../engines/engine-status-pill';
import { PendingLinkCodes } from '../engines/pending-link-codes';
import { Page } from '../shell/page';
import { useSession } from '../session/use-session';
import { OpenTeamButton } from './open-team-button';
import { TeamNameDialog } from './team-name-dialog';
import { teamKeys, teamsQuery } from './team-queries';

const MANAGE_PERMISSION = 'team.manage';
const LINK_PERMISSION = 'engine.link';

/**
 * Two lines that never fight for one: who it is (mark, name, address), then how it is (status, people). On a phone the
 * second line moves under the name instead of squeezing the address into an ellipsis.
 */
function TeamRow(props: { readonly team: TeamView; readonly engine: EngineView | undefined }) {
    const { team, engine } = props;
    const name = engineDisplayName(team, engine);
    return (
        <li className="flex items-center gap-3 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
                <span className="min-w-0 flex-1">
                    <EngineIdentity engineId={team.engineId} name={name} hostname={engine?.hostname}>
                        <Link to="/teams/$teamId" params={{ teamId: team.teamId }} variant="standalone">
                            {name}
                        </Link>
                    </EngineIdentity>
                </span>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 ps-9 text-xs text-text-muted tabular-nums sm:ps-0">
                    {engine === undefined ? (
                        team.engineId === null ? (
                            <span>{m.team_no_engine()}</span>
                        ) : null
                    ) : (
                        <EngineStatusPill engine={engine} />
                    )}
                    <span>{m.team_people_count({ count: team.memberCount })}</span>
                </span>
            </div>
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
    const canLink = session.activeOrg.permissions.includes(LINK_PERMISSION);
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
                <EmptyState
                    icon={<UsersRound aria-hidden className="size-6" />}
                    title={canManage ? m.teams_empty_title() : m.teams_empty_member_title()}
                    headingLevel={2}
                    description={canManage ? m.teams_empty_body() : m.teams_empty_member_body()}
                    {...(canManage ? { action: <NewTeamButton primary /> } : {})}
                />
            );
        }
        return (
            <ul className="-mt-3 divide-y divide-hairline" aria-label={m.teams_title()}>
                {teams.data.map((team) => (
                    <TeamRow key={team.teamId} team={team} engine={engineOf(team)} />
                ))}
            </ul>
        );
    }

    return (
        <Page
            title={m.teams_title()}
            {...(canManage && (teams.data?.length ?? 0) > 0 ? { actions: <NewTeamButton primary /> } : {})}
        >
            {content()}
            {canLink ? <PendingLinkCodes /> : null}
        </Page>
    );
}
