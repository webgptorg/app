import { Button } from '@ptbk/ui';
import { ArrowUpRight } from 'lucide-react';

import { m } from '../../../paraglide/messages';
import type { TeamView } from '../../../shared/api/routes';
import { useOpenTeam } from './open-team';

/** Opens the team's engine; only for people in the team, and only once it has an engine. */
export function OpenTeamButton(props: {
    readonly team: TeamView;
    readonly variant?: 'primary' | 'secondary';
    readonly size?: 'sm' | 'md';
}) {
    const open = useOpenTeam(props.team.teamId);
    if (!props.team.isMember || props.team.engineId === null) {
        return null;
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
