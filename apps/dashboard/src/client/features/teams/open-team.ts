import { m } from '../../../paraglide/messages';
import { apiRoutes } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { dataOrThrow, problemCode } from '../../api/queries';
import { useBrowser } from '../../core/browser';
import { useAppMutation } from '../../core/mutations';

/**
 * "Open": a fresh access ticket, then off to the engine's join page on the engine's own origin, the ticket in the
 * fragment. The page asks for approval the first time and signs the person in after that (teams spec).
 */
export function useOpenTeam(teamId: string) {
    const api = useApiClient();
    const browser = useBrowser();
    return useAppMutation({
        mutationFn: async () => dataOrThrow(await api.call(apiRoutes.createAccessTicket, { params: { teamId } })).url,
        errorMessage: (error) => (problemCode(error) === 'unavailable' ? m.team_open_unavailable() : undefined),
        onSuccess: (url) => {
            browser.navigate(url);
        },
    });
}
