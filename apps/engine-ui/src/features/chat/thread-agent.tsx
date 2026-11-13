import type { ReadParticipantRef } from '@ptbk/engine-api';

import { cx } from '../../app/cx';
import { agentTintClass } from './agent-tint';

const AVATAR_SIZES = { xs: 'size-5 text-[0.625rem]', sm: 'size-6 text-xs' } as const;

/** An agent's initial on a wash of its colour. */
export function ThreadAvatar({
    name,
    who,
    size = 'sm',
}: {
    readonly name: string;
    readonly who: ReadParticipantRef;
    readonly size?: keyof typeof AVATAR_SIZES;
}) {
    return (
        <span
            aria-hidden="true"
            className={cx(
                'chat-avatar inline-flex shrink-0 items-center justify-center rounded-full font-display font-semibold',
                agentTintClass(who),
                AVATAR_SIZES[size],
            )}
        >
            {Array.from(name.trim())[0]?.toLocaleUpperCase() ?? null}
        </span>
    );
}

/** An agent named in a card: its avatar and name in its colour. Text only. */
export function ThreadAgent({ name, who }: { readonly name: string; readonly who: ReadParticipantRef }) {
    return (
        <span className={cx('inline-flex min-w-0 items-center gap-1.5 text-xs font-medium', agentTintClass(who))}>
            <ThreadAvatar name={name} who={who} size="xs" />
            <span className="chat-agent-text truncate">{name}</span>
        </span>
    );
}
