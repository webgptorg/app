import type { AgentProfile } from '@ptbk/engine-api';

import { cx } from '../../app/cx';
import { safeImageSource } from '../../security/safe-url';
import { agentColor, tintStyle } from '../chat/references/agent-color';

const SIZE_CLASSES = {
    '2xs': 'size-4 text-[0.5625rem]',
    xs: 'size-6 text-xs',
    sm: 'size-8 text-sm',
    lg: 'size-14 text-xl',
} as const;
export type AgentAvatarSize = keyof typeof SIZE_CLASSES;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * The agent's picture, or its initial on a wash of its colour, so an agent looks the same in lists, chips, the
 * palette and a thread. The colour is its profile colour (engine data, a validated `#rrggbb`) or the palette hue its
 * key hashes to, applied through the CSSOM as `--tint`; the initial is mixed towards the text colour, so it stays
 * readable whatever the profile says. Without `agentKey` (an agent not known by ID) only a profile colour tints it.
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
    const source = profile.avatarUrl === null ? null : safeImageSource(profile.avatarUrl);
    const color =
        agentKey === undefined
            ? profile.color !== null && HEX_COLOR.test(profile.color)
                ? profile.color
                : null
            : agentColor(profile.color, agentKey);
    const classes = cx(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold select-none',
        SIZE_CLASSES[size],
        className,
    );
    if (source !== null) {
        return (
            <img
                src={source}
                alt=""
                className={cx(classes, 'object-cover outline -outline-offset-1 outline-divider')}
                style={color === null ? undefined : tintStyle(color)}
            />
        );
    }
    return (
        <span
            aria-hidden="true"
            data-agent-avatar=""
            className={cx(
                classes,
                color === null
                    ? 'bg-sunken text-text-muted'
                    : 'bg-[color-mix(in_oklab,var(--tint)_16%,var(--color-raised))] text-tint',
            )}
            style={color === null ? undefined : tintStyle(color)}
        >
            {Array.from(name.trim())[0]?.toLocaleUpperCase() ?? null}
        </span>
    );
}
