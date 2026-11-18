const TEAM_ID = /^[a-z2-7]{26}$/;
const MAX_TEAMS = 50;

export interface JoinedSearch {
    readonly teams: readonly string[];
}

/** `/joined?teams=…`: only well-formed IDs pass, and the page shows only the person's own teams among them anyway. */
export function parseJoinedSearch(search: Readonly<Record<string, unknown>>): JoinedSearch {
    const teams = search['teams'];
    return {
        teams: Array.isArray(teams)
            ? teams.filter((id): id is string => typeof id === 'string' && TEAM_ID.test(id)).slice(0, MAX_TEAMS)
            : [],
    };
}
