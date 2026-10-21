import type { MemberId } from '@ptbk/engine-api';
import { CodeText } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { useCurrentMember } from '../session/use-current-member';
import { usePermissions } from '../session/use-permissions';
import { agentCreatorQueryOptions } from './agents-queries';

/**
 * Who created an agent, by name where the member may read members; otherwise the member ID. Shown for information
 * only: nothing in the agents screens filters or decides by creator.
 */
export function AgentCreator({ memberId }: { readonly memberId: MemberId }) {
    const me = useCurrentMember();
    const { can } = usePermissions();
    const isMe = me.memberId === memberId;
    const member = useQuery({
        ...agentCreatorQueryOptions(useEngineApi(), memberId),
        enabled: !isMe && can('members.read'),
    });
    if (isMe) return <span>{m.agent_created_by_you()}</span>;
    if (member.data !== undefined) return <span>{member.data.displayName}</span>;
    return <CodeText value={memberId} />;
}
