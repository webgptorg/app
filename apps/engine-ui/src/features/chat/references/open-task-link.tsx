import { createLink } from '@tanstack/react-router';
import { ArrowUpRight } from 'lucide-react';
import type { AnchorHTMLAttributes, Ref } from 'react';

import { cx } from '../../../app/cx';
import { m } from '../../../paraglide/messages';

interface ChipAnchorProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
    readonly ref?: Ref<HTMLAnchorElement>;
}

/** A pill in the card's own wash rather than an underlined link, so an action reads as one on a soft surface. */
function ChipAnchor({ className, children, ...rest }: ChipAnchorProps) {
    return (
        <a
            {...rest}
            className={cx(
                'inline-flex min-h-7 w-fit shrink-0 items-center gap-1 rounded-pill px-2.5 text-xs font-medium text-text no-underline',
                'bg-[color-mix(in_oklab,var(--tint,var(--color-text-muted))_12%,transparent)] hover:bg-[color-mix(in_oklab,var(--tint,var(--color-text-muted))_20%,transparent)]',
                'motion-safe:transition-colors motion-safe:duration-(--motion-state)',
                className,
            )}
        >
            {children}
        </a>
    );
}

const ChipLink = createLink(ChipAnchor);

/** "Open task ↗" as a quiet chip, for task cards and hovercards. */
export function OpenTaskLink({ taskId, className }: { readonly taskId: string; readonly className?: string }) {
    return (
        <ChipLink to="/tasks/$taskId" params={{ taskId }} className={className}>
            {m.chat_ref_open_task()}
            <ArrowUpRight aria-hidden className="size-3.5" />
        </ChipLink>
    );
}
