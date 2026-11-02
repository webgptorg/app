import { useQuery } from '@tanstack/react-query';

import type { TeamView } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { useSession } from '../session/use-session';
import { teamsQuery } from '../teams/team-queries';

const TEAM_READ = 'team.read';

/**
 * The engine's team, and the name someone gave it: screens call a team an engine (ADR 0018), so that name is the
 * engine's. A team made for an engine nobody named carries its hostname or ID, which is no name.
 */
export function useEngineTeam(
    engineId: string,
    hostname: string,
): {
    readonly team: TeamView | undefined;
    readonly givenName: string | null;
} {
    const api = useApiClient();
    const session = useSession();
    const teams = useQuery({ ...teamsQuery(api), enabled: session.activeOrg.permissions.includes(TEAM_READ) });
    const team = teams.data?.find((candidate) => candidate.engineId === engineId);
    const isGiven = team !== undefined && team.name !== hostname && team.name !== engineId;
    return { team, givenName: isGiven ? team.name : null };
}
