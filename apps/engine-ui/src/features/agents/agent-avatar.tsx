import type { AgentProfile } from '@ptbk/engine-api';

import { cx } from '../../app/cx';
import { safeImageSource } from '../../security/safe-url';

const SIZE_CLASSES = { xs: 'size-6 text-xs', sm: 'size-8 text-sm', lg: 'size-14 text-xl' } as const;

/**
 * The agent's picture, or its initial. The profile colour is engine data (a validated `#rrggbb`), applied through
 * the CSSOM as a ring so text contrast never depends on it.
 */
export function AgentAvatar({
    name,
    profile,
    size = 'sm',
}: {
    readonly name: string;
    readonly profile: Pick<AgentProfile, 'avatarUrl' | 'color'>;
    readonly size?: keyof typeof SIZE_CLASSES;
}) {
    const source = profile.avatarUrl === null ? null : safeImageSource(profile.avatarUrl);
    const ring = profile.color === null ? undefined : { borderColor: profile.color };
    const className = cx(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-divider bg-raised font-display font-semibold',
        SIZE_CLASSES[size],
    );
    if (source !== null) {
        return <img src={source} alt="" className={cx(className, 'object-cover')} style={ring} />;
    }
    return (
        <span aria-hidden="true" className={className} style={ring}>
            {Array.from(name.trim())[0]?.toLocaleUpperCase() ?? null}
        </span>
    );
}
