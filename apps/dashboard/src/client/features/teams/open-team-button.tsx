import { Button } from '@ptbk/ui';
import { ArrowUpRight } from 'lucide-react';

import { m } from '../../../paraglide/messages';
import type { EngineView, TeamView } from '../../../shared/api/routes';
import { EngineOpenLink } from '../engines/engine-open-link';
import { useOpenTeam } from './open-team';

/**
 * Opens the team's engine; only for people in the team, and only once it has an engine. While the engine reports its
 * setup unfinished it continues that setup instead, through the plain link: whoever finishes it already has a passkey
 * there, so a ticket would only detour through the join page.
 */
export function OpenTeamButton(props: {
    readonly team: TeamView;
    readonly engine?: Pick<EngineView, 'status' | 'hostname'> | undefined;
    readonly variant?: 'primary' | 'secondary';
    readonly size?: 'sm' | 'md';
}) {
    const open = useOpenTeam(props.team.teamId);
    if (!props.team.isMember || props.team.engineId === null) {
        return null;
    }
    if (props.engine?.status === 'setup-pending') {
        return (
            <EngineOpenLink
                name={props.team.name}
                hostname={props.engine.hostname}
                variant={props.variant ?? 'secondary'}
                size={props.size ?? 'sm'}
                wording="setup"
            />
        );
    }
    return (
        <Button
            variant={props.variant ?? 'secondary'}
            size={props.size ?? 'sm'}
            loading={open.isPending}
            aria-label={m.team_open_named({ name: props.team.name })}
            onClick={() => {
                open.mutate();
            }}
        >
            {m.team_open()}
            <ArrowUpRight aria-hidden className="size-4" />
        </Button>
    );
}
