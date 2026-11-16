import type { AgentOrigin, AgentProfile } from '@ptbk/engine-api';
import { Avatar } from '@ptbk/ui';
import { lazy, Suspense } from 'react';
import type { AvatarSize } from '@ptbk/ui';

import { safeImageSource } from '../../security/safe-url';
import { agentColor } from '../chat/references/agent-color';
import { resolveIllustration } from './illustrations/resolve-illustration';

// Twenty drawings would cost the entry about 3 kB, and every screen shows an avatar: they load as a chunk of their own,
// asked for as soon as this module runs, so they are in before the first avatar needs them. Until then the circle
// shows its tinted wash.
const loadIllustrations = () => import('./illustrations/illustrations');
void loadIllustrations().catch(() => undefined);
const AgentIllustration = lazy(() => loadIllustrations().then((module) => ({ default: module.AgentIllustration })));

const SIZES = { '2xs': '2xs', xs: 'sm', sm: 'md', lg: 'lg', xl: 'xl' } as const satisfies Record<string, AvatarSize>;
export type AgentAvatarSize = keyof typeof SIZES;

/**
 * The agent's picture, or its illustration on a wash of its colour: its profile colour, else the palette hue its key
 * hashes to, so an agent looks the same in lists, chips, the palette and a thread. Without `agentKey` (an agent not
 * known by ID) only a profile colour tints it. `Avatar` passes only a `#rrggbb` or a colour token on to CSS. The
 * profile's role and illustration, and `origin`, refine which illustration it gets; without them the name alone
 * picks one.
 */
export function AgentAvatar({
    name,
    profile,
    origin,
    agentKey,
    size = 'sm',
    className,
}: {
    readonly name: string;
    readonly profile: Pick<AgentProfile, 'avatarUrl' | 'color'> & {
        readonly description?: string | undefined;
        readonly illustration?: string | null | undefined;
    };
    readonly origin?: AgentOrigin | undefined;
    readonly agentKey?: string | undefined;
    readonly size?: AgentAvatarSize;
    readonly className?: string | undefined;
}) {
    return (
        <Avatar
            name={name}
            src={profile.avatarUrl === null ? null : safeImageSource(profile.avatarUrl)}
            tint={agentKey === undefined ? profile.color : agentColor(profile.color, agentKey)}
            picture={
                <Suspense fallback={null}>
                    <AgentIllustration id={resolveIllustration({ name, origin, profile })} className="size-[84%]" />
                </Suspense>
            }
            size={SIZES[size]}
            {...(className === undefined ? {} : { className })}
        />
    );
}
