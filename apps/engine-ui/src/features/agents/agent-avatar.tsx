import type { AgentProfile } from '@ptbk/engine-api';
import { Avatar } from '@ptbk/ui';
import type { AvatarSize } from '@ptbk/ui';

import { safeImageSource } from '../../security/safe-url';
import { agentColor } from '../chat/references/agent-color';

const SIZES = { '2xs': '2xs', xs: 'sm', sm: 'md', lg: 'lg' } as const satisfies Record<string, AvatarSize>;
export type AgentAvatarSize = keyof typeof SIZES;

/**
 * The agent's picture, or its initial on a wash of its colour: its profile colour, else the palette hue its key hashes
 * to, so an agent looks the same in lists, chips, the palette and a thread. Without `agentKey` (an agent not known by
 * ID) only a profile colour tints it. `Avatar` passes only a `#rrggbb` or a colour token on to CSS.
 */
export function AgentAvatar({
    name,
    profile,
    agentKey,
    size = 'sm',
    className,
}: {
    readonly name: string;
    readonly profile: Pick<AgentProfile, 'avatarUrl' | 'color'>;
    readonly agentKey?: string | undefined;
    readonly size?: AgentAvatarSize;
    readonly className?: string | undefined;
}) {
    return (
        <Avatar
            name={name}
            src={profile.avatarUrl === null ? null : safeImageSource(profile.avatarUrl)}
            tint={agentKey === undefined ? profile.color : agentColor(profile.color, agentKey)}
            size={SIZES[size]}
            {...(className === undefined ? {} : { className })}
        />
    );
}
