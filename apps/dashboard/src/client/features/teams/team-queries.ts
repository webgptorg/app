import { queryOptions } from '@tanstack/react-query';

import { apiRoutes } from '../../../shared/api/routes';
import type { ApiClient } from '../../api/api-client';
import { dataOrThrow } from '../../api/queries';

export const teamKeys = {
    all: ['teams'] as const,
    team: (teamId: string) => ['teams', teamId] as const,
    people: ['org', 'people'] as const,
};

export function teamsQuery(client: ApiClient) {
    return queryOptions({
        queryKey: teamKeys.all,
        queryFn: async ({ signal }) => dataOrThrow(await client.call(apiRoutes.listTeams, {}, signal)).teams,
    });
}

/** The team, its people with their access, people being removed, and pending invitations naming it. */
export function teamQuery(client: ApiClient, teamId: string) {
    return queryOptions({
        queryKey: teamKeys.team(teamId),
        queryFn: async ({ signal }) =>
            dataOrThrow(await client.call(apiRoutes.getTeam, { params: { teamId } }, signal)),
    });
}

export function peopleQuery(client: ApiClient) {
    return queryOptions({
        queryKey: teamKeys.people,
        queryFn: async ({ signal }) => dataOrThrow(await client.call(apiRoutes.listOrgMembers, {}, signal)),
    });
}
